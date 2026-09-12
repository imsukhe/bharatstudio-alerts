// Razorpay behind CreatorPaymentProvider. Wraps the existing, unmodified
// PaymentAccountStore (src/domain/payment-account.ts, implemented by
// src/db/payment-account-store.ts) — no behaviour change, no new DB access.
//
// Capability evidence (repo-internal only; no provider-policy claims):
//   supportsUpiIntent / supportsCards: true — Razorpay order creation
//     (services/payment-webhook-go/internal/provider/razorpay_orders.go,
//     `CreateOrderRequest`) carries no payment-method restriction, so every
//     method enabled on the connected account's Razorpay Orders/Checkout is
//     available; this codebase does not narrow it.
//   supportsDynamicQr: false — no QR-creation call exists anywhere in this
//     codebase (grepped services/payment-webhook-go and apps/api). L19
//     task 4 ("dynamic/order-bound QR for desktop") is not started.
//   supportsRefunds: false — services/payment-webhook-go/internal/reconcile/
//     refund.go and refund_handler.go only fetch and reconcile refund
//     *status* (`RefundProvider.FetchRefundForAccount`); no call anywhere
//     issues/creates a refund via Razorpay's API. Reporting `true` here
//     would let L17's refund-capability gate pass on a capability that does
//     not exist yet — see this task's report, "The refunds:true correction".
//   supportsRecurringPayments: false — CreateTipOrderInput
//     (src/domain/payment-order.ts) has no mandate/recurring field, and
//     master plan L18 states native recurring membership is "v2, gated on
//     economics" / not started.
//   supportsInternationalPayments: false — CreateTipOrderInput's currency
//     field is the literal type 'INR' (src/domain/payment-order.ts), not a
//     currency union; nothing in this codebase requests a non-INR payment.
import type { PaymentAccount, PaymentAccountStore } from './payment-account.js';
import {
  PaymentProviderNotImplementedError,
  type ConnectionCapabilities,
  type CreatePaymentResult,
  type CreateQrResult,
  type CreatorPaymentIntent,
  type CreatorPaymentProvider,
  type PaymentStatus,
  type RefundResult,
  type WebhookVerifierRef,
} from './payment-provider-creator.js';

const RAZORPAY_CAPABILITIES: ConnectionCapabilities = {
  schemaVersion: 'v1',
  provider: 'razorpay',
  supportsUpiIntent: true,
  supportsDynamicQr: false,
  supportsRefunds: false,
  supportsRecurringPayments: false,
  supportsCards: true,
  supportsInternationalPayments: false,
};

export function createRazorpayPaymentProvider(accountStore: PaymentAccountStore): CreatorPaymentProvider {
  return {
    providerId: 'razorpay',

    connectionCapabilities(): ConnectionCapabilities {
      return RAZORPAY_CAPABILITIES;
    },

    listAccounts(userId: string, channelId: string): Promise<PaymentAccount[]> {
      return accountStore.list(userId, channelId);
    },

    connectAccount(userId: string, channelId: string, environment: 'test' | 'live', connectedAccountRef: string): Promise<PaymentAccount> {
      return accountStore.register(userId, channelId, environment, connectedAccountRef);
    },

    revokeAccount(userId: string, channelId: string, environment: 'test' | 'live'): Promise<boolean> {
      return accountStore.revoke(userId, channelId, environment);
    },

    skipAccountOnboarding(userId: string, channelId: string): Promise<string> {
      return accountStore.skipOnboarding(userId, channelId);
    },

    async createPayment(_intent: CreatorPaymentIntent): Promise<CreatePaymentResult> {
      // Tip-order creation is owned by src/domain/payment-order.ts +
      // src/routes/public.ts, outside this task's file ownership. Not
      // wired here — see this task's report, "Behaviour preservation".
      throw new PaymentProviderNotImplementedError('razorpay', 'createPayment', 'order creation lives in payment-order.ts, out of this task scope');
    },

    async createQr(_intent: CreatorPaymentIntent): Promise<CreateQrResult> {
      throw new PaymentProviderNotImplementedError('razorpay', 'createQr', 'dynamic QR is L19 task 4, not built by any rail yet');
    },

    async fetchPayment(_providerPaymentRef: string): Promise<PaymentStatus> {
      throw new PaymentProviderNotImplementedError('razorpay', 'fetchPayment', 'payment status projection lives in payment-ledger.ts, out of this task scope');
    },

    async refund(_providerPaymentRef: string, _amountPaise: number): Promise<RefundResult> {
      throw new PaymentProviderNotImplementedError('razorpay', 'refund', 'no refund-initiation call exists in this codebase; only status reconciliation does');
    },

    webhookVerifier(): WebhookVerifierRef {
      return {
        provider: 'razorpay',
        implementedAt: 'services/payment-webhook-go/internal/webhook/verifier.go',
      };
    },
  };
}
