export type CreateBillingSubscriptionInput = {
  userId: string;
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
  tier: 'pro' | 'creator' | 'studio';
  billingInterval: 'monthly' | 'annual';
};

export type BillingSubscription = {
  schemaVersion: 'v1';
  provider: 'razorpay';
  status: 'linked' | 'pending';
  subscriptionId: string;
  tier: CreateBillingSubscriptionInput['tier'];
  billingInterval: CreateBillingSubscriptionInput['billingInterval'];
  monthlyPricePaise: number;
  annualChargePaise: number;
  // 1/1 for a monthly subscription, 10/12 for annual — matches the
  // per-interval relationship packages/db/migrations/0048's own CHECK
  // constraint enforces. Not a literal 10/12: a monthly subscription
  // (the only interval apps/web's "Subscribe" button ever actually
  // requests) is charged its monthly price for one month of service.
  annualMonthsCharged: number;
  annualServiceMonths: number;
  checkoutUrl: string | null;
};

// Lifecycle requests (cancel / upgrade / downgrade / reactivate) only ever
// tell Razorpay what to do next; they never themselves report the confirmed
// billing state. Confirmed state (grandfathering, grace period, tier) keeps
// coming exclusively from GET /v1/channels/:channelId/billing, which reads
// the webhook-confirmed projection — never from this call's response.
export type SubscriptionLifecycleAction = 'cancel' | 'upgrade' | 'downgrade' | 'reactivate';

export type CancelSubscriptionInput = {
  userId: string;
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
};

export type ChangeSubscriptionPlanInput = {
  userId: string;
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
  targetTier: 'pro' | 'creator' | 'studio';
  billingInterval: 'monthly' | 'annual';
};

export type ReactivateSubscriptionInput = {
  userId: string;
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
};

export type SubscriptionLifecycleResult = {
  schemaVersion: 'v1';
  action: SubscriptionLifecycleAction;
  requestId: string;
  status: 'requested' | 'provider_confirmed' | 'provider_failed';
  replay: boolean;
};

export interface PaymentSubscriptionService {
  createSubscription(input: CreateBillingSubscriptionInput, traceId?: string): Promise<BillingSubscription>;
  cancelSubscription(input: CancelSubscriptionInput, traceId?: string): Promise<SubscriptionLifecycleResult>;
  changeSubscriptionPlan(input: ChangeSubscriptionPlanInput, action: 'upgrade' | 'downgrade', traceId?: string): Promise<SubscriptionLifecycleResult>;
  reactivateSubscription(input: ReactivateSubscriptionInput, traceId?: string): Promise<SubscriptionLifecycleResult>;
}
