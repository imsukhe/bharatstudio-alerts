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
  annualMonthsCharged: 10;
  annualServiceMonths: 12;
  checkoutUrl: string | null;
};

export interface PaymentSubscriptionService {
  createSubscription(input: CreateBillingSubscriptionInput, traceId?: string): Promise<BillingSubscription>;
}
