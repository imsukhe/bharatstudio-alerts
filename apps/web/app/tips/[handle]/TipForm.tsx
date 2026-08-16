'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { getApiOrigin } from '../../lib/api-origin';
import { boundedServerMessage, parsePublicOrderStatus, parseTipOrderResponse, type PublicOrderStatus, type TipOrderResponse } from './tip-contract';
import { fetchTipOrder, getOrCreateTipIdempotencyKey, shouldRetainTipIdempotencyKey } from '../tip-client';
import { loadRazorpayCheckout } from './razorpay-loader';

type TipFormProps = { handle: string; acceptingTips: boolean; minimumTipPaise: number };

const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;

// A donor who paid but whose confirmation poll timed out (slow bank/webhook —
// the exact case the architecture expects) previously had no way to check
// again: no order reference shown, and a reload lost all local order state.
// This persists just enough (order id + amount, never payment details) to
// survive a reload and re-enable a manual status check. Scoped per-handle so
// a donor tipping two different creators in the same browser doesn't cross
// their pending orders.
type PendingOrder = { orderId: string; amountPaise: number };

function pendingOrderStorageKey(handle: string): string {
  return `bharatstudio.tip.pending.${handle}`;
}

function loadPendingOrder(handle: string): PendingOrder | null {
  try {
    const raw = window.sessionStorage.getItem(pendingOrderStorageKey(handle));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as { orderId?: unknown }).orderId === 'string'
      && typeof (parsed as { amountPaise?: unknown }).amountPaise === 'number'
    ) {
      return parsed as PendingOrder;
    }
    return null;
  } catch {
    return null;
  }
}

function storePendingOrder(handle: string, value: PendingOrder): void {
  try {
    window.sessionStorage.setItem(pendingOrderStorageKey(handle), JSON.stringify(value));
  } catch {
    // Best-effort only — a donor without sessionStorage access (private
    // browsing, storage disabled) still completes the tip; they just don't
    // get the reload-survives-it convenience.
  }
}

function clearPendingOrder(handle: string): void {
  try {
    window.sessionStorage.removeItem(pendingOrderStorageKey(handle));
  } catch {
    // No-op — see storePendingOrder.
  }
}

export function TipForm({ handle, acceptingTips, minimumTipPaise }: TipFormProps) {
  const [amount, setAmount] = useState('100');
  const [donorDisplayName, setDonorDisplayName] = useState('');
  const [message, setMessage] = useState('');
  const [alertConsent, setAlertConsent] = useState(true);
  const [state, setState] = useState<'idle' | 'submitting' | 'created' | 'checking' | 'paid' | 'expired' | 'error'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [order, setOrder] = useState<TipOrderResponse | null>(null);
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    const restored = loadPendingOrder(handle);
    if (restored) {
      setPendingOrder(restored);
      setState('created');
      setNotice('Payment was submitted before you left this page. Confirmation may still be pending — check again below.');
    }
    // Only ever restore once per mount; the handle a donor is viewing doesn't
    // change without a full navigation to a different page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acceptingTips) return;
    const rupees = Number(amount);
    const minimumRupees = Math.ceil(minimumTipPaise / 100);
    if (!Number.isSafeInteger(rupees) || rupees < minimumRupees) {
      setError(`Enter an amount of at least ₹${minimumRupees.toLocaleString('en-IN')}.`);
      setState('error');
      return;
    }

    setState('submitting');
    setError('');
    setNotice('');
    setOrder(null);
    const requestKey = getOrCreateTipIdempotencyKey(idempotencyKey.current, () => crypto.randomUUID());
    idempotencyKey.current = requestKey;
    try {
      const response = await fetchTipOrder({ url: `${getApiOrigin()}/v1/public/channels/${encodeURIComponent(handle)}/tips/orders`, init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': requestKey },
        body: JSON.stringify({
          amountPaise: rupees * 100,
          currency: 'INR',
          donorDisplayName: donorDisplayName.trim() || null,
          message: message.trim() || null,
          alertConsent,
        }),
      } });
      const value = await response.json() as unknown;
      const parsed = parseTipOrderResponse(value, rupees * 100);
      if (!response.ok || !parsed) {
        if (!shouldRetainTipIdempotencyKey(response.status, false)) idempotencyKey.current = null;
        throw new Error(boundedServerMessage(value && typeof value === 'object' ? (value as Record<string, unknown>).message : undefined) ?? 'Secure checkout is temporarily unavailable.');
      }
      setOrder(parsed);
      setState('created');
      const pending: PendingOrder = { orderId: parsed.orderId, amountPaise: parsed.amountPaise };
      setPendingOrder(pending);
      storePendingOrder(handle, pending);
      if (await startCheckout({ providerOrderId: parsed.providerOrderId, localOrderId: parsed.orderId, amountPaise: parsed.amountPaise })) {
        idempotencyKey.current = null;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Secure checkout is temporarily unavailable.');
      setState('error');
    }
  }

  // A single, immediate status check — used by both the auto-poll below and
  // the manual "Check status" button a donor can press after a timed-out
  // poll, or after returning to this page having left with a pending order.
  // Returns true once a terminal state (paid/expired/failed) is reached.
  async function checkOnce(orderId: string): Promise<boolean> {
    try {
      const response = await fetchTipOrder({
        url: `${getApiOrigin()}/v1/public/tip-orders/${encodeURIComponent(orderId)}/status`,
        init: { cache: 'no-store' },
        timeoutMs: 5_000,
      });
      if (!response.ok) return false;
      const value = parsePublicOrderStatus(await response.json());
      if (!value) return false;
      if (value.status === 'paid') {
        setState('paid');
        setNotice('Payment confirmed by BharatStudio. The creator’s alert will follow their configured display and consent settings.');
        setPendingOrder(null);
        clearPendingOrder(handle);
        return true;
      }
      if (value.status === 'expired' || value.status === 'failed') {
        setState('expired');
        setNotice('No successful payment confirmation was received for this order. You can start a new tip if needed.');
        setPendingOrder(null);
        clearPendingOrder(handle);
        return true;
      }
      return false;
    } catch {
      // Polling is advisory; the provider webhook and durable payment ledger remain authoritative.
      return false;
    }
  }

  async function pollOrderStatus(orderId: string): Promise<void> {
    setState('checking');
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      if (await checkOnce(orderId)) return;
    }
    setState('created');
    setNotice(`Payment was submitted. Confirmation is still pending — use "Check status" below whenever you're ready to look again.`);
  }

  async function checkStatusNow() {
    if (!pendingOrder) return;
    setNotice('Checking payment confirmation…');
    const done = await checkOnce(pendingOrder.orderId);
    if (!done) setNotice('Still no confirmation yet. This can take a few minutes for some banks — feel free to check again shortly.');
  }

  async function startCheckout(input: { providerOrderId: string; localOrderId: string; amountPaise: number }): Promise<boolean> {
    if (!RAZORPAY_KEY_ID) {
      setError('Checkout is temporarily unavailable. The creator can still see the prepared order after the provider is enabled.');
      setState('error');
      return false;
    }
    const Razorpay = await loadRazorpayCheckout();
    const checkout = new Razorpay({
      key: RAZORPAY_KEY_ID,
      amount: input.amountPaise,
      currency: 'INR',
      name: 'BharatStudio',
      description: 'Creator tip',
      order_id: input.providerOrderId,
      // Razorpay's Checkout timeout is expressed in seconds. This mirrors
      // the server/database's fifteen-minute local intent lifetime; the
      // verified webhook remains the source of financial truth.
      timeout: 900,
      handler: () => {
        // The browser callback is intentionally informational only. The
        // verified Razorpay webhook remains the source of payment truth.
        void pollOrderStatus(input.localOrderId);
      },
      modal: { ondismiss: () => setNotice('Checkout closed. You can retry this order if payment was not completed.') },
    });
    checkout.open();
    return true;
  }

  return (
    <form className="tip-form" onSubmit={submit} aria-describedby="tip-form-helper">
      <label htmlFor="tip-amount">Amount</label>
      <div className="amount-row"><span>₹</span><input id="tip-amount" inputMode="numeric" min={Math.ceil(minimumTipPaise / 100)} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!acceptingTips || state === 'submitting'} /></div>
      <label htmlFor="tip-name">Name <span>(optional)</span></label>
      <input id="tip-name" maxLength={80} value={donorDisplayName} onChange={(event) => setDonorDisplayName(event.target.value)} placeholder="How should we thank you?" disabled={!acceptingTips || state === 'submitting'} />
      <label htmlFor="tip-message">Message <span>(optional)</span></label>
      <textarea id="tip-message" rows={4} maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write something kind…" disabled={!acceptingTips || state === 'submitting'} />
      <label className="consent-row" htmlFor="tip-alert-consent">
        <input id="tip-alert-consent" type="checkbox" checked={alertConsent} onChange={(event) => setAlertConsent(event.target.checked)} disabled={!acceptingTips || state === 'submitting'} />
        <span>Allow this message to appear in the creator’s alert</span>
      </label>
      <button className="primary-button full-width" type="submit" disabled={!acceptingTips || state === 'submitting' || state === 'checking'}>{state === 'submitting' ? 'Preparing secure checkout…' : state === 'checking' ? 'Checking payment confirmation…' : acceptingTips ? 'Continue to tip' : 'Tips are closed'}</button>
      {state === 'created' && order ? <p className="inline-message" role="status">Order prepared for ₹{Math.round(order.amountPaise / 100)}. Complete the secure checkout window; payment confirmation is verified by the provider webhook.</p> : null}
      {state === 'paid' ? <p className="inline-message" role="status">Payment confirmed. Thank you for supporting the stream.</p> : null}
      {state === 'checking' ? <p className="inline-message" role="status">Payment submitted. Checking the server-confirmed status; this can take a few seconds.</p> : null}
      {notice ? <p className="inline-message" role="status">{notice}</p> : null}
      {state === 'error' ? <p className="error-text" role="alert">{error}</p> : null}
      {pendingOrder && state === 'created' ? (
        <div className="pending-order-check">
          <p className="helper-text">
            Order reference: <code>{pendingOrder.orderId}</code> · ₹{Math.round(pendingOrder.amountPaise / 100).toLocaleString('en-IN')}. Save this if you need to contact support about this tip.
          </p>
          <button className="secondary-button" type="button" onClick={checkStatusNow}>Check status</button>
        </div>
      ) : null}
      <p id="tip-form-helper" className="helper-text">The platform minimum is ₹10; this channel’s minimum is ₹{Math.ceil(minimumTipPaise / 100).toLocaleString('en-IN')}. Your payment is recorded independently of whether you allow an on-stream alert.</p>
    </form>
  );
}
