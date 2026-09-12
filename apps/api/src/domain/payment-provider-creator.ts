// CreatorPaymentProvider — the provider-neutral abstraction for the
// viewer-pays-creator monetisation rail (L19, master plan section 10.4
// item 16 / "L19 — Payment provider abstraction and multi-rail").
//
// This is deliberately the CreatorPaymentConnections domain, never
// PlatformBilling (BharatStudio's own ₹199/₹399/₹599 SaaS subscription —
// see src/domain/payment-subscription.ts). Master plan 1.4 "Two separate
// payment domains": the two must never share a table or an abstraction.
// A rail here only ever moves money viewer -> creator; BharatStudio is
// never merchant of record and never holds funds (master plan 1.4,
// "creator_balance / withdrawable_amount / bharatstudio_held_funds /
// payout_request must never exist in the schema").
//
// Razorpay is the only implementation today (payment-provider-razorpay.ts).
// This interface exists so a second rail is a new implementation of it,
// not a rewrite of every caller.
import type { PaymentAccount } from './payment-account.js';

/** What a connected rail can actually do — asked, never assumed. */
export type ConnectionCapabilities = {
  schemaVersion: 'v1';
  provider: string;
  /** UPI collect/intent flow (as opposed to only a hosted checkout page). */
  supportsUpiIntent: boolean;
  /** Order/intent-bound dynamic QR (L19 task 4 — not built by any rail yet). */
  supportsDynamicQr: boolean;
  /**
   * True only when this codebase can both verify AND programmatically
   * initiate a refund through the rail's API. BharatStudio's Razorpay
   * integration today verifies/reconciles refund status
   * (services/payment-webhook-go/internal/reconcile/refund.go) but has no
   * refund-initiation call anywhere in the codebase — see the Razorpay
   * implementation's doc comment for the exact evidence. Do not flip this
   * to true without adding that call and a test that proves it.
   */
  supportsRefunds: boolean;
  /** Recurring/mandate-based capture for the creator-monetisation rail
   *  (native BharatStudio recurring membership is master plan L18 "v2,
   *  gated on economics" — not started). Distinct from PlatformBilling's
   *  own subscription billing, which is a different domain entirely. */
  supportsRecurringPayments: boolean;
  supportsCards: boolean;
  supportsInternationalPayments: boolean;
};

export type CreatorPaymentIntent = {
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
  intentId: string;
  amountPaise: number;
  currency: 'INR';
};

export type CreatePaymentResult = {
  schemaVersion: 'v1';
  provider: string;
  providerPaymentRef: string;
  status: 'created' | 'pending';
  checkoutUrl: string | null;
};

export type CreateQrResult = {
  schemaVersion: 'v1';
  provider: string;
  providerQrRef: string;
  qrImageUrl: string;
  expiresAt: string;
};

export type PaymentStatus = {
  schemaVersion: 'v1';
  provider: string;
  providerPaymentRef: string;
  status: 'created' | 'pending' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
};

export type RefundResult = {
  schemaVersion: 'v1';
  provider: string;
  providerRefundRef: string;
  status: 'requested' | 'processed' | 'failed';
};

/**
 * Deliberately NOT a signature-verification method. Verifying a raw-body
 * HMAC and deduping on a provider event id is a security property that must
 * stay structural (see this task's return report, "Security properties made
 * structural"). Putting it behind an interface method that every future
 * rail must remember to implement correctly is exactly the failure mode the
 * task brief warns against — a second, easy-to-get-wrong copy of signature
 * verification. Today's single verifier lives in
 * services/payment-webhook-go/internal/webhook/verifier.go and stays the
 * one source of truth; this method exists on the interface only so a
 * caller can name "which verifier backs this rail" without re-implementing
 * it, and the Razorpay implementation intentionally throws rather than
 * silently offering a second, unverified path.
 */
export type WebhookVerifierRef = {
  provider: string;
  /** Where the canonical verifier for this rail actually lives. */
  implementedAt: string;
};

export interface CreatorPaymentProvider {
  readonly providerId: string;

  connectionCapabilities(): ConnectionCapabilities;

  // --- creator account connect/verify -------------------------------
  listAccounts(userId: string, channelId: string): Promise<PaymentAccount[]>;
  connectAccount(userId: string, channelId: string, environment: 'test' | 'live', connectedAccountRef: string): Promise<PaymentAccount>;
  revokeAccount(userId: string, channelId: string, environment: 'test' | 'live'): Promise<boolean>;
  skipAccountOnboarding(userId: string, channelId: string): Promise<string>;

  // --- payment operations ---------------------------------------------
  // Present on the interface per master plan 10.4/L19 so a future rail's
  // shape is decided now. Only the account-connect group above is wired to
  // a live route this pass (see payment-accounts.ts) — order creation,
  // dynamic QR, status fetch and refund issuance are owned by files outside
  // this task's scope (payment-order.ts / the payment-webhook-go service)
  // and are not touched here. See "Behaviour preservation" / "Remaining
  // open" in this task's report.
  createPayment(intent: CreatorPaymentIntent): Promise<CreatePaymentResult>;
  createQr(intent: CreatorPaymentIntent): Promise<CreateQrResult>;
  fetchPayment(providerPaymentRef: string): Promise<PaymentStatus>;
  refund(providerPaymentRef: string, amountPaise: number): Promise<RefundResult>;
  webhookVerifier(): WebhookVerifierRef;
}

export class PaymentProviderNotImplementedError extends Error {
  constructor(provider: string, operation: string, reason: string) {
    super(`${provider} does not implement ${operation}: ${reason}`);
    this.name = 'PaymentProviderNotImplementedError';
  }
}
