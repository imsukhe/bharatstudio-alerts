'use client';

import { useState } from 'react';
import { getApiOrigin } from '../../lib/api-origin';
import { boundedServerMessage, parsePublicOrderStatus, parseTipOrderResponse, type TipOrderResponse } from '../../tips/[handle]/tip-contract';
import { fetchTipOrder } from '../../tips/tip-client';
import { loadRazorpayCheckout } from '../../tips/[handle]/razorpay-loader';

type Props = {
  token: string;
  channelDisplayName: string;
  amountPaise: number;
  donorDisplayName: string | null;
  message: string | null;
};

const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;

/**
 * No form here — deliberately. The amount/name/message shown are exactly
 * what app_private.consume_tip_intent will use server-side; there is
 * nothing on this page for a viewer to edit that could change what the
 * creator receives (see routes/public.ts POST /v1/public/tip-intents/
 * :token/orders, whose body schema does not even accept amountPaise).
 */
export function TipIntentConfirm({ token, channelDisplayName, amountPaise, donorDisplayName, message }: Props) {
  const [state, setState] = useState<'idle' | 'confirming' | 'created' | 'checking' | 'paid' | 'failed' | 'error' | 'gone'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [order, setOrder] = useState<TipOrderResponse | null>(null);

  async function checkOnce(orderId: string): Promise<boolean> {
    try {
      const response = await fetchTipOrder({ url: `${getApiOrigin()}/v1/public/tip-orders/${encodeURIComponent(orderId)}/status`, init: { cache: 'no-store' }, timeoutMs: 5_000 });
      if (!response.ok) return false;
      const value = parsePublicOrderStatus(await response.json());
      if (!value) return false;
      if (value.status === 'paid') {
        setState('paid');
        setNotice('Payment confirmed. Thank you for supporting the stream.');
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
      modal: { ondismiss: () => setNotice('Checkout closed. This support link was already used for one order; you cannot retry it.') },
    });
    checkout.open();
  }

  async function confirm() {
    setState('confirming');
    setError('');
    try {
      const response = await fetchTipOrder({
        url: `${getApiOrigin()}/v1/public/tip-intents/${encodeURIComponent(token)}/orders`,
        init: { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({}) },
      });
      const value = await response.json() as unknown;
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
    }
  }

  return (
    <div className="tipintent-confirm">
      <p className="creator-mark" aria-hidden="true">{channelDisplayName.slice(0, 1).toUpperCase()}</p>
      <p className="eyebrow">{channelDisplayName}</p>
      {donorDisplayName ? <p className="tipintent-donor">{donorDisplayName}</p> : null}
      <p className="tipintent-amount">₹{Math.round(amountPaise / 100).toLocaleString('en-IN')}</p>
      {message ? <p className="tipintent-message">&ldquo;{message}&rdquo;</p> : null}
      <button className="primary-button full-width" type="button" onClick={confirm} disabled={state === 'confirming' || state === 'created' || state === 'checking' || state === 'paid' || state === 'gone'}>
        {state === 'confirming' ? 'Preparing secure checkout…' : state === 'checking' ? 'Checking payment confirmation…' : state === 'paid' ? 'Payment confirmed' : `Confirm ₹${Math.round(amountPaise / 100)} support`}
      </button>
      {state === 'created' && order ? <p className="inline-message" role="status">Complete the secure checkout window; confirmation is verified by the provider webhook.</p> : null}
      {notice ? <p className="inline-message" role="status">{notice}</p> : null}
      {state === 'error' ? <p className="error-text" role="alert">{error}</p> : null}
    </div>
  );
}
