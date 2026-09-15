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
//   supportsDynamicQr: true (L19d) — a genuinely new Razorpay call
//     (POST /v1/payments/qr_codes, services/payment-webhook-go/internal/
//     provider/razorpay_qr.go), reached through a new internal service
//     (internal/qr) and endpoint (/internal/v1/tips/qr) on the same
//     payment-webhook-go service that already owns every other Razorpay
//     call, so secrets and the webhook contract never gain a second
//     source. Like createPayment, createQr throws when this provider
//     instance was not given a DynamicQrService (db/payment-provider-
//     razorpay-qr-client.ts) — capability truth is about the rail, wiring
//     truth is about the instance.
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
// fetchPayment stays throwing. A provider-order fetch DOES exist
// (services/payment-webhook-go/internal/provider/razorpay_orders.go
// FetchOrderForAccount), but it is not a general-purpose "fetch this
// payment" call this interface method could safely wrap: it is used only by
// the background reconciliation runner (internal/reconcile/runner.go),
// whose Evaluate policy (internal/reconcile/reconcile.go) decides what a
// fetched order means against the local intent — a "paid" order only
// queues payment recovery, it never overwrites the ledger directly. Adding
// fetchPayment here would create a second, policy-free consumer of that
// same fetch, and the exact disagreement this task's brief warns about
// (a live fetch that disagrees with the reconciled ledger) would have no
// answer at that second call site. This codebase's payment-status truth
// stays the webhook-populated ledger (payment-ledger.ts /
// public-payment-status.ts); a live fetch is reconciliation input, not a
// second source of truth. Correct refusal, not a gap.
import type { PaymentAccount, PaymentAccountStore } from './payment-account.js';
import type { PaymentOrderService } from './payment-order.js';
import {
  PaymentProviderNotImplementedError,
  type ConnectionCapabilities,
  type CreatePaymentResult,
  type CreateQrResult,
  type CreatorPaymentIntent,
  type CreatorPaymentProvider,
  type DynamicQrService,
  type PaymentStatus,
  type RefundResult,
  type WebhookVerifierRef,
} from './payment-provider-creator.js';

const RAZORPAY_CAPABILITIES: ConnectionCapabilities = {
  schemaVersion: 'v1',
  provider: 'razorpay',
  supportsUpiIntent: true,
  supportsDynamicQr: true,
  supportsRefunds: false,
  supportsRecurringPayments: false,
  supportsCards: true,
  supportsInternationalPayments: false,
};

// accountStore/paymentOrders/qrService are all optional so this one factory
// serves multiple live call sites with different needs, with no branching
// outside this file: payment-accounts.ts (owns account connect/verify,
// never calls createPayment or createQr) passes only accountStore;
// routes/public.ts (owns the money-moving tip flow) passes paymentOrders
// and, once wired, qrService. Calling an operation whose backing dependency
// was not supplied throws — same fail-closed shape as every other
// not-yet-implemented method below, never a silent no-op. This mirrors
// createPayment's existing precedent exactly: connectionCapabilities()
// reports what this rail is capable of, not whether this particular
// instance happens to be wired for it.
export function createRazorpayPaymentProvider(accountStore?: PaymentAccountStore, paymentOrders?: PaymentOrderService, qrService?: DynamicQrService): CreatorPaymentProvider {
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
          anonymousIdentityTokenHash: intent.anonymousIdentityTokenHash,
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

    async createQr(intent: CreatorPaymentIntent, traceId?: string): Promise<CreateQrResult> {
      if (!qrService) {
        // Matches createPayment's precedent exactly: an instance built
        // without a DynamicQrService (e.g. payment-accounts.ts's
        // account-only instance) throws rather than silently no-oping.
        throw new PaymentProviderNotImplementedError('razorpay', 'createQr', 'no DynamicQrService configured for this provider instance');
      }
      if (typeof intent.expiresAt !== 'string') {
        // A QR needs a concrete close-by time; a bare capability-check-style
        // intent with no expiresAt is never silently given one.
        throw new PaymentProviderNotImplementedError('razorpay', 'createQr', 'intent is missing expiresAt required to bound how long the QR stays open');
      }
      return qrService.createDynamicQr(
        {
          channelId: intent.channelId,
          environment: intent.environment,
          intentId: intent.intentId,
          closeBy: intent.expiresAt,
        },
        traceId,
      );
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
