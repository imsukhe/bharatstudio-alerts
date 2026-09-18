'use client';

import { useRef, useState } from 'react';
import { getApiOrigin } from '../../lib/api-origin';
import { boundedServerMessage, parsePublicOrderStatus, parseTipOrderResponse, type TipOrderResponse } from '../../tips/[handle]/tip-contract';
import { fetchTipOrder } from '../../tips/tip-client';
import { loadRazorpayCheckout } from '../../tips/[handle]/razorpay-loader';
import { mintReceiptForConfirmedTip, receiptPath } from '../../tips/receipt-client';
import { missingProductionTurnstileSiteKey, publicTurnstileSiteKey, TurnstileChallenge } from '../../tips/turnstile-challenge';

type Props = {
  token: string;
  channelDisplayName: string;
  amountPaise: number;
  donorDisplayName: string | null;
  message: string | null;
  turnstileSiteKey?: string;
  turnstileNodeEnv?: string;
};

const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
const TURNSTILE_SITE_KEY = publicTurnstileSiteKey();
const TURNSTILE_NODE_ENV = String(process.env.NODE_ENV ?? '');

/**
 * No form here — deliberately. The amount/name/message shown are exactly
 * what app_private.reserve_tip_intent_checkout returns server-side before
 * it may be completed; there is nothing on this page for a viewer to edit
 * that could change what the creator receives (see routes/public.ts POST
 * /v1/public/tip-intents/:token/orders, whose body schema does not even
 * accept amountPaise).
 */
export function TipIntentConfirm({ token, channelDisplayName, amountPaise, donorDisplayName, message, turnstileSiteKey = TURNSTILE_SITE_KEY, turnstileNodeEnv = TURNSTILE_NODE_ENV }: Props) {
  const [state, setState] = useState<'idle' | 'confirming' | 'created' | 'checking' | 'paid' | 'failed' | 'error' | 'gone'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [order, setOrder] = useState<TipOrderResponse | null>(null);
  const [receiptToken, setReceiptToken] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  // Kept only in this mounted page instance. It must survive a modal
  // dismissal/transient failure, but is intentionally never written to URL,
  // localStorage, sessionStorage, analytics, or logs.
  const idempotencyKey = useRef<string | null>(null);

  async function checkOnce(orderId: string): Promise<boolean> {
    try {
      const response = await fetchTipOrder({ url: `${getApiOrigin()}/v1/public/tip-orders/${encodeURIComponent(orderId)}/status`, init: { cache: 'no-store' }, timeoutMs: 5_000 });
      if (!response.ok) return false;
      const value = parsePublicOrderStatus(await response.json());
      if (!value) return false;
      if (value.status === 'paid') {
        setState('paid');
        setNotice('Payment confirmed. Thank you for supporting the stream.');
        // Same advisory receipt handoff as the direct-tip journey. The
        // verified payment state is final even if receipt minting is down.
        void mintReceiptForConfirmedTip(getApiOrigin(), orderId).then((token) => {
          if (token) setReceiptToken(token);
        });
        return true;
      }
      if (value.status === 'expired' || value.status === 'failed') {
        setState('failed');
        setNotice('No successful payment confirmation was received. This support link has already been used and cannot be retried — ask in chat for a new one.');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function pollOrderStatus(orderId: string): Promise<void> {
    setState('checking');
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      if (await checkOnce(orderId)) return;
    }
    setNotice('Payment was submitted. Confirmation is still pending — this can take a few minutes for some banks.');
  }

  async function startCheckout(providerOrderId: string, localOrderId: string): Promise<void> {
    if (!RAZORPAY_KEY_ID) {
      setError('Checkout is temporarily unavailable.');
      setState('error');
      return;
    }
    const Razorpay = await loadRazorpayCheckout();
    const checkout = new Razorpay({
      key: RAZORPAY_KEY_ID,
      amount: amountPaise,
      currency: 'INR',
      name: 'BharatStudio',
      description: `Support for ${channelDisplayName}`,
      order_id: providerOrderId,
      timeout: 900,
      handler: () => { void pollOrderStatus(localOrderId); },
      modal: { ondismiss: () => setNotice('Checkout closed. You can reopen this prepared checkout; payment is confirmed only after the provider webhook.') },
    });
    checkout.open();
  }

  async function confirm() {
    if (state === 'created' && order) {
      try {
        setError('');
        await startCheckout(order.providerOrderId, order.orderId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Secure checkout is temporarily unavailable.');
      }
      return;
    }
    if (missingProductionTurnstileSiteKey(turnstileSiteKey, turnstileNodeEnv)) {
      setError('Secure checkout is temporarily unavailable. Please try again later.');
      setState('error');
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError('Please complete the security check before continuing.');
      setState('error');
      return;
    }
    setState('confirming');
    setError('');
    const requestKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestKey;
    try {
      const response = await fetchTipOrder({
        url: `${getApiOrigin()}/v1/public/tip-intents/${encodeURIComponent(token)}/orders`,
        init: { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify(turnstileToken ? { turnstileToken } : {}) },
      });
      const value = await response.json() as unknown;
      const errorCode = value && typeof value === 'object' ? (value as Record<string, unknown>).errorCode : undefined;
      if (response.status === 409 && errorCode === 'tip_intent_checkout_in_progress') {
        throw new Error('A secure checkout is already being prepared for this support link. Return to the original page to reopen it.');
      }
      if (response.status === 409 || response.status === 410 || response.status === 404) {
        setState('gone');
        setNotice(boundedServerMessage(value && typeof value === 'object' ? (value as Record<string, unknown>).message : undefined) ?? 'This support link can no longer be used.');
        return;
      }
      const parsed = parseTipOrderResponse(value, amountPaise);
      if (!response.ok || !parsed) {
        throw new Error(boundedServerMessage(value && typeof value === 'object' ? (value as Record<string, unknown>).message : undefined) ?? 'Secure checkout is temporarily unavailable.');
      }
      setOrder(parsed);
      setState('created');
      await startCheckout(parsed.providerOrderId, parsed.orderId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Secure checkout is temporarily unavailable.');
      setState('error');
    } finally {
      if (turnstileSiteKey) {
        setTurnstileToken(null);
        setTurnstileResetNonce((value) => value + 1);
      }
    }
  }

  return (
    <div className="tipintent-confirm">
      <p className="creator-mark" aria-hidden="true">{channelDisplayName.slice(0, 1).toUpperCase()}</p>
      <p className="eyebrow">{channelDisplayName}</p>
      {donorDisplayName ? <p className="tipintent-donor">{donorDisplayName}</p> : null}
      <p className="tipintent-amount">₹{Math.round(amountPaise / 100).toLocaleString('en-IN')}</p>
      {message ? <p className="tipintent-message">&ldquo;{message}&rdquo;</p> : null}
      <TurnstileChallenge siteKey={turnstileSiteKey} onToken={setTurnstileToken} resetNonce={turnstileResetNonce} />
      <button className="primary-button full-width" type="button" onClick={confirm} disabled={state === 'confirming' || state === 'checking' || state === 'paid' || state === 'failed' || state === 'gone'}>
        {state === 'confirming' ? 'Preparing secure checkout…' : state === 'checking' ? 'Checking payment confirmation…' : state === 'paid' ? 'Payment confirmed' : state === 'created' ? 'Reopen secure checkout' : `Confirm ₹${Math.round(amountPaise / 100)} support`}
      </button>
      {state === 'created' && order ? <p className="inline-message" role="status">Complete the secure checkout window; confirmation is verified by the provider webhook.</p> : null}
      {notice ? <p className="inline-message" role="status">{notice}</p> : null}
      {receiptToken ? <p className="inline-message"><a href={receiptPath(receiptToken)}>View your receipt</a></p> : null}
      {state === 'error' ? <p className="error-text" role="alert">{error}</p> : null}
    </div>
  );
}
