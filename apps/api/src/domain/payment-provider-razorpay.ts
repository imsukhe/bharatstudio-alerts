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
//     task 4 ("dynamic/order-bound QR for desktop") is not started, and
//     genuinely cannot be from this task's file ownership: every real
//     Razorpay API call in this codebase lives in the Go payment-webhook
//     service (services/payment-webhook-go), which this task's boundary
//     explicitly excludes. Building QR would mean either a second,
//     unowned Razorpay caller from apps/api (a second place secrets and
//     the webhook contract could drift) or editing services/ — both out
//     of scope. See this task's report, "Remaining open".
//   supportsRefunds: false — services/payment-webhook-go/internal/reconcile/
//     refund.go and refund_handler.go only fetch and reconcile refund
//     *status* (`RefundProvider.FetchRefundForAccount`); no call anywhere
//     issues/creates a refund via Razorpay's API. Reporting `true` here
//     would let L17's refund-capability gate pass on a capability that does
//     not exist yet — see this task's report, "The refunds:true correction".
//     This stays throwing deliberately: master plan 3.15/1.4 records the
//     absence of a refund-initiation call as correct under the no-custody
//     rule, not a gap to close.
//   supportsRecurringPayments: false — CreateTipOrderInput
//     (src/domain/payment-order.ts) has no mandate/recurring field, and
//     master plan L18 states native recurring membership is "v2, gated on
//     economics" / not started.
//   supportsInternationalPayments: false — CreateTipOrderInput's currency
//     field is the literal type 'INR' (src/domain/payment-order.ts), not a
//     currency union; nothing in this codebase requests a non-INR payment.
//
// createPayment: NOW wired to the real, live tip-order path. It delegates
// to the same PaymentOrderService (src/domain/payment-order.ts,
// implemented by src/db/payment-order-client.ts's Google-ID-token-signed
// call to the Go payment-webhook service's /internal/v1/tips/orders) that
// routes/public.ts called directly before this task — see this task's
// report, "The tip flow, before and after". Nothing about the HMAC
// webhook verification, the Go service's own account/idempotency
// handling, or the wire call itself changed; only what calls
// paymentOrders.createTipOrder moved, from routes/public.ts straight into
// this provider.
//
// fetchPayment stays throwing: this codebase's payment-status truth comes
// from the webhook-populated ledger read in payment-ledger.ts / the public
// status route (public-payment-status.ts), not from a "fetch this payment
// from Razorpay" API call — no such call exists anywhere in this
// codebase (grepped services/payment-webhook-go and apps/api). Faking one
// here would be the "silent no-op" the task brief explicitly warns
// against.
import type { PaymentAccount, PaymentAccountStore } from './payment-account.js';
import type { PaymentOrderService } from './payment-order.js';
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

// accountStore/paymentOrders are both optional so this one factory serves
// two live call sites with different needs, with no branching outside this
// file: payment-accounts.ts (owns account connect/verify, never calls
// createPayment) passes only accountStore; routes/public.ts (owns the
// money-moving tip flow, never touches accounts) passes only
// paymentOrders. Calling an operation whose backing dependency was not
// supplied throws — same fail-closed shape as every other
// not-yet-implemented method below, never a silent no-op.
export function createRazorpayPaymentProvider(accountStore?: PaymentAccountStore, paymentOrders?: PaymentOrderService): CreatorPaymentProvider {
  function requireAccountStore(): PaymentAccountStore {
    if (!accountStore) throw new Error('razorpay provider: no PaymentAccountStore configured for this instance');
    return accountStore;
  }

  return {
    providerId: 'razorpay',

    connectionCapabilities(): ConnectionCapabilities {
      return RAZORPAY_CAPABILITIES;
    },

    listAccounts(userId: string, channelId: string): Promise<PaymentAccount[]> {
      return requireAccountStore().list(userId, channelId);
    },

    connectAccount(userId: string, channelId: string, environment: 'test' | 'live', connectedAccountRef: string): Promise<PaymentAccount> {
      return requireAccountStore().register(userId, channelId, environment, connectedAccountRef);
    },

    revokeAccount(userId: string, channelId: string, environment: 'test' | 'live'): Promise<boolean> {
      return requireAccountStore().revoke(userId, channelId, environment);
    },

    skipAccountOnboarding(userId: string, channelId: string): Promise<string> {
      return requireAccountStore().skipOnboarding(userId, channelId);
    },

    async createPayment(intent: CreatorPaymentIntent, traceId?: string): Promise<CreatePaymentResult> {
      if (!paymentOrders) {
        // Matches the pre-widening behaviour exactly for every existing
        // caller that never supplies a PaymentOrderService (e.g. the
        // account-only instance payment-accounts.ts builds, and this
        // file's own l19b regression test).
        throw new PaymentProviderNotImplementedError('razorpay', 'createPayment', 'no PaymentOrderService configured for this provider instance');
      }
      if (
        typeof intent.donorDisplayName !== 'string'
        || typeof intent.message !== 'string'
        || typeof intent.alertConsent !== 'boolean'
        || typeof intent.providerReceipt !== 'string'
        || typeof intent.expiresAt !== 'string'
      ) {
        // A real tip order needs all five fields together (see
        // CreatorPaymentIntent's doc comment) — a partial intent is never
        // silently coerced into an order.
        throw new PaymentProviderNotImplementedError('razorpay', 'createPayment', 'intent is missing one or more tip-order fields (donorDisplayName/message/alertConsent/providerReceipt/expiresAt) required to create a real order');
      }
      const order = await paymentOrders.createTipOrder(
        {
          channelId: intent.channelId,
          environment: intent.environment,
          idempotencyKey: intent.idempotencyKey,
          intentId: intent.intentId,
          providerReceipt: intent.providerReceipt,
          amountPaise: intent.amountPaise,
          currency: intent.currency,
          donorDisplayName: intent.donorDisplayName,
          message: intent.message,
          alertConsent: intent.alertConsent,
          expiresAt: intent.expiresAt,
        },
        traceId,
      );
      return {
        schemaVersion: 'v1',
        provider: 'razorpay',
        providerPaymentRef: order.providerOrderId,
        status: order.status,
        checkoutUrl: null,
        orderId: order.orderId,
        amountPaise: order.amountPaise,
        currency: order.currency,
      };
    },

    async createQr(_intent: CreatorPaymentIntent): Promise<CreateQrResult> {
      throw new PaymentProviderNotImplementedError('razorpay', 'createQr', 'dynamic QR is L19 task 4; no Razorpay QR call exists anywhere in this codebase, and building one is out of this task\'s file ownership (see the doc comment above)');
    },

    async fetchPayment(_providerPaymentRef: string): Promise<PaymentStatus> {
      throw new PaymentProviderNotImplementedError('razorpay', 'fetchPayment', 'no fetch-payment-from-Razorpay call exists in this codebase; payment status is projected from the webhook-populated ledger (payment-ledger.ts), not fetched on demand');
    },

    async refund(_providerPaymentRef: string, _amountPaise: number): Promise<RefundResult> {
      throw new PaymentProviderNotImplementedError('razorpay', 'refund', 'no refund-initiation call exists in this codebase; only status reconciliation does, per master plan 1.4/3.15 no-custody rule');
    },

    webhookVerifier(): WebhookVerifierRef {
      return {
        provider: 'razorpay',
        implementedAt: 'services/payment-webhook-go/internal/webhook/verifier.go',
      };
    },
  };
}
