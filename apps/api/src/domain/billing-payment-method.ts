// A creator can never hand BharatStudio a card/UPI credential to "update"
// (docs/BharatStudio-MASTER-PLAN.md#1.4 — BharatStudio never touches
// instrument data and holds no funds). The only operation that can exist
// here is: authenticate the caller, then hand back a short-lived, opaque
// link into Razorpay's own hosted flow for re-authorising the instrument
// on the existing subscription. Nothing about the request or response
// below can carry instrument data or a mutable amount/plan.

export type RequestPaymentMethodUpdateLinkInput = {
  userId: string;
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
};

export type PaymentMethodUpdateLink = {
  schemaVersion: 'v1';
  provider: 'razorpay';
  // Opaque, provider-hosted URL. Never carries plan/tier/amount as a
  // client-visible parameter — see assertLink's query-string check in
  // billing-payment-method-client.ts.
  updateUrl: string;
  // Short-lived: the client just checks this is in the future and the
  // service layer additionally rejects anything beyond a bounded lifetime.
  expiresAt: string;
};

export class PaymentMethodUpdateForbiddenError extends Error {
  constructor() {
    super('channel owner or admin role required');
    this.name = 'PaymentMethodUpdateForbiddenError';
  }
}

export interface PaymentMethodUpdateService {
  requestUpdateLink(input: RequestPaymentMethodUpdateLinkInput, traceId?: string): Promise<PaymentMethodUpdateLink>;
}
