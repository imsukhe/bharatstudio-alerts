import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_tipintent_retry';
const apiOriginPath = new URL('../../lib/api-origin.ts', import.meta.url).pathname;
let tipIntentPromise: Promise<typeof import('./TipIntentConfirm').TipIntentConfirm> | undefined;

async function loadTipIntentConfirm() {
  if (!tipIntentPromise) {
    mock.module(apiOriginPath, { namedExports: { getApiOrigin: () => 'https://api.example.test' } });
    tipIntentPromise = import('./TipIntentConfirm').then((module) => module.TipIntentConfirm);
  }
  return tipIntentPromise;
}

test('a configured immutable tip-intent sends a Turnstile response but never sends mutable intent fields', async () => {
  const TipIntentConfirm = await loadTipIntentConfirm();
  let challenge: { callback?: (token: string) => void } | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const resets: string[] = [];
  const previousTurnstile = window.turnstile;
  const previousFetch = globalThis.fetch;
  window.turnstile = {
    render: (_element, options) => { challenge = options; return 'intent-widget'; },
    reset: (id) => resets.push(id), remove: () => {},
  };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/tip-intents/')) {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schemaVersion: 'v1', errorCode: 'bot_verification_required', message: 'security check failed' }), { status: 403 });
    }
    throw new Error(`unexpected ${String(url)}`);
  }) as typeof fetch;

  try {
    render(<TipIntentConfirm token="opaque-token" channelDisplayName="Creator" amountPaise={2500} donorDisplayName="Donor" message="Hello" turnstileSiteKey="site-key" />);
    const confirm = screen.getByRole('button', { name: /confirm ₹25 support/i });
    fireEvent.click(confirm);
    await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /complete the security check/i));
    assert.equal(requestBody, undefined);

    await act(async () => { challenge?.callback?.('intent-response'); });
    fireEvent.click(confirm);
    await waitFor(() => assert.deepEqual(requestBody, { turnstileToken: 'intent-response' }));
    await waitFor(() => assert.deepEqual(resets, ['intent-widget']));
  } finally {
    window.turnstile = previousTurnstile;
    globalThis.fetch = previousFetch;
  }
});

test('a dismissed TipIntent checkout reopens the same prepared order without a second API request', async () => {
  const TipIntentConfirm = await loadTipIntentConfirm();
  const previousFetch = globalThis.fetch;
  const previousRazorpay = window.Razorpay;
  const checkoutOptions: Array<{ order_id: string; modal: { ondismiss: () => void } }> = [];
  let requests = 0;
  window.Razorpay = class {
    constructor(options: { order_id: string; modal: { ondismiss: () => void } }) { checkoutOptions.push(options); }
    open() {}
  } as typeof window.Razorpay;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/tip-intents/')) {
      requests += 1;
      assert.match(String((init?.headers as Record<string, string>)['Idempotency-Key']), /^[0-9a-f-]{36}$/i);
      return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000001', provider: 'razorpay', providerOrderId: 'order_tipintent_retry_1', amountPaise: 2500, currency: 'INR', status: 'created' }), { status: 201 });
    }
    throw new Error(`unexpected ${String(url)}`);
  }) as typeof fetch;
  try {
    render(<TipIntentConfirm token="opaque-token" channelDisplayName="Creator" amountPaise={2500} donorDisplayName={null} message={null} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm ₹25 support/i }));
    await waitFor(() => assert.equal(checkoutOptions.length, 1));
    await act(async () => { checkoutOptions[0]?.modal.ondismiss(); });
    await waitFor(() => assert.ok(screen.getByText(/checkout closed/i)));
    fireEvent.click(screen.getByRole('button', { name: /reopen secure checkout/i }));
    await waitFor(() => assert.equal(checkoutOptions.length, 2));
    assert.equal(checkoutOptions[1]?.order_id, 'order_tipintent_retry_1');
    assert.equal(requests, 1, 'reopen must use the existing durable checkout, not call the order endpoint again');
  } finally {
    globalThis.fetch = previousFetch;
    window.Razorpay = previousRazorpay;
  }
});

test('a retryable TipIntent-order failure retains its page-only idempotency key', async () => {
  const TipIntentConfirm = await loadTipIntentConfirm();
  const previousFetch = globalThis.fetch;
  const previousRazorpay = window.Razorpay;
  const idempotencyKeys: string[] = [];
  let calls = 0;
  window.Razorpay = class { constructor(_options: unknown) {} open() {} } as typeof window.Razorpay;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/tip-intents/')) {
      calls += 1;
      idempotencyKeys.push(String((init?.headers as Record<string, string>)['Idempotency-Key']));
      if (calls === 1) return new Response(JSON.stringify({ schemaVersion: 'v1', errorCode: 'payment_unavailable', message: 'temporary outage', retryable: true }), { status: 503 });
      return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000002', provider: 'razorpay', providerOrderId: 'order_tipintent_retry_2', amountPaise: 2500, currency: 'INR', status: 'created' }), { status: 201 });
    }
    throw new Error(`unexpected ${String(url)}`);
  }) as typeof fetch;
  try {
    render(<TipIntentConfirm token="opaque-token" channelDisplayName="Creator" amountPaise={2500} donorDisplayName={null} message={null} />);
    const confirm = screen.getByRole('button', { name: /confirm ₹25 support/i });
    fireEvent.click(confirm);
    await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /temporary outage/i));
    fireEvent.click(confirm);
    await waitFor(() => assert.equal(calls, 2));
    assert.match(idempotencyKeys[0] ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(idempotencyKeys[1], idempotencyKeys[0]);
  } finally {
    globalThis.fetch = previousFetch;
    window.Razorpay = previousRazorpay;
  }
});
