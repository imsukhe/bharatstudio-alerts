export type CreateTipOrderInput = {
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
  intentId: string;
  providerReceipt: string;
  amountPaise: number;
  currency: 'INR';
  donorDisplayName: string;
  message: string;
  alertConsent: boolean;
  expiresAt: string;
};

export type TipOrder = {
  schemaVersion: 'v1';
  orderId: string;
  provider: 'razorpay';
  providerOrderId: string;
  amountPaise: number;
  currency: 'INR';
  status: 'created' | 'pending';
};

export interface PaymentOrderService {
  createTipOrder(input: CreateTipOrderInput, traceId?: string): Promise<TipOrder>;
}
