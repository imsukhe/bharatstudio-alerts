'use client';

/*
 * Billing lifecycle actions: subscribe (free -> paid, Razorpay checkout
 * redirect), upgrade, downgrade, cancel, reactivate. All call the real
 * backend routes added under the billing-lifecycle-backend task:
 *   POST /v1/channels/:id/billing/subscription
 *   POST /v1/channels/:id/billing/subscription/{cancel,upgrade,downgrade,reactivate}
 *
 * A lifecycle action only tells Razorpay what to do next — it does not
 * itself change the confirmed tier/renewal state. That only ever comes from
 * GET /v1/channels/:id/billing (the webhook-confirmed projection), so every
 * action here re-fetches billing after a short delay rather than assuming
 * its own success response is the new state.
 */
import { useState } from 'react';
import {
  cancelSubscription, createSubscription, downgradeSubscription, getAccessToken, getBilling, isApprovedCheckoutUrl,
  reactivateSubscription, upgradeSubscription, type BillingView, type PaidTier,
} from '../lib/api';
import { getApiOrigin } from '../lib/api-origin';

/*
 * There is no field in this app that accepts a card/UPI credential, and
 * there never will be — see routes/alerts.ts's payment-method route
 * (apps/api/src/routes/alerts.ts): it accepts no request body and returns
 * only an opaque, short-lived link into Razorpay's own hosted flow. This
 * client-side call mirrors the existing lib/api.ts request conventions
 * (getApiOrigin + Bearer token + JSON) rather than adding to lib/api.ts,
 * which belongs to a different ownership lane than this file.
 */
type PaymentMethodUpdateLink = { schemaVersion: 'v1'; provider: 'razorpay'; updateUrl: string; expiresAt: string };

async function requestPaymentMethodUpdateLink(channelId: string): Promise<PaymentMethodUpdateLink> {
  const token = getAccessToken();
  if (!token) throw new Error('Authentication required');
  if (!globalThis.crypto?.randomUUID) throw new Error('secure_random_unavailable');
  const response = await fetch(`${getApiOrigin()}/v1/channels/${encodeURIComponent(channelId)}/billing/payment-method`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': globalThis.crypto.randomUUID() },
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = 'Could not start the payment method update. Please try again.';
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) message = body.message;
    } catch { /* keep bounded fallback */ }
    throw new Error(message);
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (value.schemaVersion !== 'v1' || value.provider !== 'razorpay' || typeof value.updateUrl !== 'string' || typeof value.expiresAt !== 'string') {
    throw new Error('Server response was invalid');
  }
  return { schemaVersion: 'v1', provider: 'razorpay', updateUrl: value.updateUrl, expiresAt: value.expiresAt };
}

type Props = {
  channelId: string;
  billing: BillingView;
  onUpdated: (next: BillingView) => void;
};

type ConfirmKind = 'downgrade' | 'cancel';

const PLAN_PRICES_PAISE: Record<PaidTier, number> = { pro: 19900, creator: 39900, studio: 49900 };
const PAID_TIERS: PaidTier[] = ['pro', 'creator', 'studio'];
const TIER_ORDER: Record<BillingView['tier'], number> = { free: 0, pro: 1, creator: 2, studio: 3 };

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatPrice(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}/mo`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'the end of your billing period';
  try {
    return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return 'the end of your billing period';
  }
}

export function BillingActionsPanel({ channelId, billing, onUpdated }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const [confirmTier, setConfirmTier] = useState<PaidTier | null>(null);

  const anyLoading = loading !== null;
  const isCancelled = billing.renewalState === 'cancelled';
  const isPastDue = billing.renewalState === 'past_due';
  const currentOrder = TIER_ORDER[billing.tier];
  const upgradableTiers = PAID_TIERS.filter((tier) => TIER_ORDER[tier] > currentOrder);
  const downgradablePaidTiers = PAID_TIERS.filter((tier) => TIER_ORDER[tier] < currentOrder && TIER_ORDER[tier] > 0);

  function clearFeedback() {
    setError(null);
    setNotice(null);
  }

  function dismissConfirm() {
    setConfirmKind(null);
    setConfirmTier(null);
  }

  // Confirmed state (tier, renewalState) only ever comes from the webhook
  // projection, never from a lifecycle call's own response — this refresh
  // is best-effort UI feedback, not the source of truth. A slower webhook
  // still lands; the next normal page load reflects it either way.
  async function refreshBillingSoon() {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      onUpdated(await getBilling(channelId));
    } catch {
      // Best-effort refresh only; the read failing here is not itself an
      // action failure and must not surface as one.
    }
  }

  async function handleSubscribe(tier: PaidTier) {
    clearFeedback();
    const key = `subscribe-${tier}`;
    setLoading(key);
    try {
      const result = await createSubscription(channelId, tier, 'monthly');
      if (result.checkoutUrl) {
        if (!isApprovedCheckoutUrl(result.checkoutUrl)) {
          setError('Invalid checkout URL. Please contact support.');
          setLoading(null);
          return;
        }
        window.location.href = result.checkoutUrl;
        return;
      }
      setNotice(`Subscribing to ${tierLabel(tier)}…`);
      setLoading(null);
      await refreshBillingSoon();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Subscription failed. Please try again.');
      setLoading(null);
    }
  }

  async function handleUpgrade(tier: PaidTier) {
    clearFeedback();
    const key = `upgrade-${tier}`;
    setLoading(key);
    try {
      await upgradeSubscription(channelId, tier, billing.billingInterval);
      setNotice(`Upgrading to ${tierLabel(tier)} — takes effect on your current billing cycle.`);
      setLoading(null);
      await refreshBillingSoon();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upgrade failed. Please try again.');
      setLoading(null);
    }
  }

  function initiateDowngrade(tier: PaidTier) {
    clearFeedback();
    setConfirmKind('downgrade');
    setConfirmTier(tier);
  }

  async function executeDowngrade() {
    const tier = confirmTier;
    if (!tier) return;
    const key = `downgrade-${tier}`;
    setLoading(key);
    dismissConfirm();
    try {
      await downgradeSubscription(channelId, tier, billing.billingInterval);
      setNotice(`Downgrade to ${tierLabel(tier)} scheduled for ${formatDate(billing.currentPeriodEndsAt)}.`);
      setLoading(null);
      await refreshBillingSoon();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Downgrade failed. Please try again.');
      setLoading(null);
    }
  }

  function initiateCancel() {
    clearFeedback();
    setConfirmKind('cancel');
    setConfirmTier(null);
  }

  async function executeCancel() {
    setLoading('cancel');
    dismissConfirm();
    try {
      await cancelSubscription(channelId);
      setNotice(`Subscription cancelled. Your plan stays active until ${formatDate(billing.currentPeriodEndsAt)}, then moves to Free.`);
      setLoading(null);
      await refreshBillingSoon();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancellation failed. Please try again.');
      setLoading(null);
    }
  }

  // Reused for both recovery paths: for a cancelled subscription this
  // resumes auto-renew before the plan lapses; for past_due it asks the
  // provider to retry the charge on the instrument already on file. It
  // does not by itself change the instrument — see handleUpdatePaymentMethod
  // below for that path (POST /v1/channels/:id/billing/payment-method).
  async function handleReactivate() {
    clearFeedback();
    setLoading('reactivate');
    try {
      await reactivateSubscription(channelId);
      setNotice(isPastDue ? 'Retrying your payment…' : 'Reactivating — your plan continues as normal.');
      setLoading(null);
      await refreshBillingSoon();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reactivation failed. Please try again.');
      setLoading(null);
    }
  }

  // Redirects into Razorpay's own hosted flow to re-authorise the
  // instrument on the existing subscription. BharatStudio never sees or
  // handles the card/UPI details themselves — same SEC-BILLING-001
  // allowlist as the subscribe checkout redirect guards this one too.
  async function handleUpdatePaymentMethod() {
    clearFeedback();
    setLoading('update-payment-method');
    try {
      const link = await requestPaymentMethodUpdateLink(channelId);
      if (!isApprovedCheckoutUrl(link.updateUrl)) {
        setError('Invalid payment update link. Please contact support.');
        setLoading(null);
        return;
      }
      window.location.href = link.updateUrl;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the payment method update. Please try again.');
      setLoading(null);
    }
  }

  return (
    <div className="billing-actions">
      {isPastDue && (
        <div className="channel-row billing-cancelled-row">
          <div>
            <strong>Payment failed</strong>
            <span>Retry now, or update your payment method if your card/UPI account changed or expired.</span>
          </div>
          <div className="control-actions">
            <button type="button" className="secondary-button" onClick={() => void handleUpdatePaymentMethod()} disabled={anyLoading}>
              {loading === 'update-payment-method' ? 'Opening…' : 'Update payment method'}
            </button>
            <button type="button" className="primary-button" onClick={() => void handleReactivate()} disabled={anyLoading}>
              {loading === 'reactivate' ? 'Retrying…' : 'Retry payment'}
            </button>
          </div>
        </div>
      )}

      {isCancelled && (
        <div className="channel-row billing-cancelled-row">
          <div>
            <strong>Plan ends {formatDate(billing.currentPeriodEndsAt)}</strong>
            <span>Reactivate before this date to keep your current plan.</span>
          </div>
          <button type="button" className="secondary-button" onClick={() => void handleReactivate()} disabled={anyLoading}>
            {loading === 'reactivate' ? 'Processing…' : 'Reactivate'}
          </button>
        </div>
      )}

      {notice && <p className="inline-message" role="status">{notice}</p>}
      {error && <p className="inline-message error-text" role="alert">{error}</p>}

      {billing.tier === 'free' && (
        <div className="channel-list">
          {PAID_TIERS.map((tier) => {
            const key = `subscribe-${tier}`;
            return (
              <div className="channel-row" key={tier}>
                <div>
                  <strong>{tierLabel(tier)} — {formatPrice(PLAN_PRICES_PAISE[tier])}</strong>
                  <span>Cancel anytime</span>
                </div>
                <button type="button" className="primary-button" onClick={() => void handleSubscribe(tier)} disabled={anyLoading}>
                  {loading === key ? 'Processing…' : 'Subscribe'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {billing.tier !== 'free' && !isCancelled && (
        <div className="channel-list">
          {upgradableTiers.map((tier) => {
            const key = `upgrade-${tier}`;
            return (
              <div className="channel-row" key={tier}>
                <div>
                  <strong>Upgrade to {tierLabel(tier)} — {formatPrice(PLAN_PRICES_PAISE[tier])}</strong>
                  <span>Immediate — new billing cycle starts now</span>
                </div>
                <button type="button" className="primary-button" onClick={() => void handleUpgrade(tier)} disabled={anyLoading}>
                  {loading === key ? 'Processing…' : 'Upgrade'}
                </button>
              </div>
            );
          })}

          {downgradablePaidTiers.map((tier) => {
            const key = `downgrade-${tier}`;
            const isConfirming = confirmKind === 'downgrade' && confirmTier === tier;
            return (
              <div key={tier}>
                <div className="channel-row">
                  <div>
                    <strong>Downgrade to {tierLabel(tier)} — {formatPrice(PLAN_PRICES_PAISE[tier])}</strong>
                    <span>Scheduled — takes effect at end of billing period</span>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => initiateDowngrade(tier)} disabled={anyLoading || !!confirmKind}>
                    {loading === key ? 'Processing…' : 'Downgrade'}
                  </button>
                </div>
                {isConfirming && (
                  <div className="billing-confirm">
                    <p className="helper-text">
                      Downgrade to {tierLabel(tier)}? You keep access to your current plan until {formatDate(billing.currentPeriodEndsAt)}.
                    </p>
                    <div className="control-actions">
                      <button type="button" className="primary-button" onClick={() => void executeDowngrade()} disabled={anyLoading}>Yes, downgrade</button>
                      <button type="button" className="secondary-button" onClick={dismissConfirm}>Keep plan</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div>
            <div className="channel-row">
              <div>
                <strong>Cancel subscription</strong>
                <span>Moves to Free at end of billing period — no refund</span>
              </div>
              <button type="button" className="secondary-button" onClick={initiateCancel} disabled={anyLoading || !!confirmKind}>
                {loading === 'cancel' ? 'Processing…' : 'Cancel plan'}
              </button>
            </div>
            {confirmKind === 'cancel' && (
              <div className="billing-confirm">
                <p className="helper-text">
                  Cancel subscription? Your plan stays active until {formatDate(billing.currentPeriodEndsAt)}, then moves to Free. No refund for unused time.
                </p>
                <div className="control-actions">
                  <button type="button" className="primary-button" onClick={() => void executeCancel()} disabled={anyLoading}>Yes, cancel</button>
                  <button type="button" className="secondary-button" onClick={dismissConfirm}>Keep plan</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
