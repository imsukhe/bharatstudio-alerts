import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The module reads this at import time. A synthetic public key is enough for
// a browser handoff test; it is never sent to a provider.
process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_tip_retry';

const apiOriginPath = new URL('../../lib/api-origin.ts', import.meta.url).pathname;
let tipFormPromise: Promise<typeof import('./TipForm').TipForm> | undefined;

async function loadTipForm() {
  if (!tipFormPromise) {
    mock.module(apiOriginPath, { namedExports: { getApiOrigin: () => 'https://api.example.test' } });
    tipFormPromise = import('./TipForm').then((module) => module.TipForm);
  }
  return tipFormPromise;
}

test('a configured ordinary tip challenge blocks the order until callback and sends only its opaque response', async () => {
  const TipForm = await loadTipForm();
  let challenge: { callback?: (token: string) => void } | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const resets: string[] = [];
  const previousTurnstile = window.turnstile;
  window.turnstile = {
    render: (_element, options) => { challenge = options; return 'tip-widget'; },
    reset: (id) => resets.push(id), remove: () => {},
  };
  mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/paid-votes')) return new Response(JSON.stringify({ schemaVersion: 'v1', items: [] }), { status: 200 });
    if (String(url).endsWith('/tips/orders')) {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schemaVersion: 'v1', errorCode: 'bot_verification_required', message: 'security check failed' }), { status: 403 });
    }
    throw new Error(`unexpected ${String(url)}`);
  });

  try {
    render(<TipForm handle="challenge_creator" acceptingTips minimumTipPaise={1000} turnstileSiteKey="site-key" />);
    const form = screen.getByRole('button', { name: /continue to tip/i }).closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /complete the security check/i));
    assert.equal(requestBody, undefined);

    await act(async () => { challenge?.callback?.('opaque-client-response'); });
    fireEvent.submit(form);
    await waitFor(() => assert.equal(requestBody?.turnstileToken, 'opaque-client-response'));
    await waitFor(() => assert.deepEqual(resets, ['tip-widget']));
    assert.equal('amountPaise' in (requestBody ?? {}), true);
    assert.equal(window.sessionStorage.length, 0);
    assert.equal(window.localStorage.length, 0);
  } finally {
    window.turnstile = previousTurnstile;
  }
});

test('an ordinary tip does not issue a doomed request when production has no public site key', async () => {
  const TipForm = await loadTipForm();
  let orderRequests = 0;
  mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/tips/orders')) orderRequests += 1;
    return new Response(JSON.stringify({ schemaVersion: 'v1', items: [] }), { status: 200 });
  });
  render(<TipForm handle="missing_key" acceptingTips minimumTipPaise={1000} turnstileNodeEnv="production" />);
  fireEvent.submit(screen.getByRole('button', { name: /continue to tip/i }).closest('form')!);
  await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /temporarily unavailable/i));
  assert.equal(orderRequests, 0);
});

test('a dismissed direct checkout reopens its prepared provider order without creating another order', async () => {
  const TipForm = await loadTipForm();
  const previousFetch = globalThis.fetch;
  const previousRazorpay = window.Razorpay;
  const checkoutOptions: Array<{ order_id: string; modal: { ondismiss: () => void } }> = [];
  let orderRequests = 0;
  window.Razorpay = class {
    constructor(options: { order_id: string; modal: { ondismiss: () => void } }) { checkoutOptions.push(options); }
    open() {}
  } as typeof window.Razorpay;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith('/paid-votes')) return new Response(JSON.stringify({ schemaVersion: 'v1', items: [] }), { status: 200 });
    if (String(url).endsWith('/tips/orders')) {
      orderRequests += 1;
      return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000001', provider: 'razorpay', providerOrderId: 'order_retry_1', amountPaise: 10000, currency: 'INR', status: 'created' }), { status: 201 });
    }
    throw new Error(`unexpected ${String(url)}`);
  }) as typeof fetch;
  try {
    render(<TipForm handle="retry_creator" acceptingTips minimumTipPaise={1000} />);
    fireEvent.submit(screen.getByRole('button', { name: /continue to tip/i }).closest('form')!);
    await waitFor(() => assert.equal(checkoutOptions.length, 1));
    assert.equal(orderRequests, 1);
    await act(async () => { checkoutOptions[0]?.modal.ondismiss(); });
    await waitFor(() => assert.ok(screen.getByText(/checkout closed/i)));
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    assert.equal(amount.disabled, true, 'a prepared order locks mutable form data until terminal status');
    fireEvent.click(screen.getByRole('button', { name: /reopen secure checkout/i }));
    await waitFor(() => assert.equal(checkoutOptions.length, 2));
    assert.equal(checkoutOptions[1]?.order_id, 'order_retry_1');
    assert.equal(orderRequests, 1, 'reopening must not allocate a second payment order');
  } finally {
    globalThis.fetch = previousFetch;
    window.Razorpay = previousRazorpay;
  }
});

test('a retryable direct-order failure keeps the same in-memory idempotency key for recovery', async () => {
  const TipForm = await loadTipForm();
  const previousFetch = globalThis.fetch;
  const previousRazorpay = window.Razorpay;
  const idempotencyKeys: string[] = [];
  let calls = 0;
  window.Razorpay = class { constructor(_options: unknown) {} open() {} } as typeof window.Razorpay;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/paid-votes')) return new Response(JSON.stringify({ schemaVersion: 'v1', items: [] }), { status: 200 });
    if (String(url).endsWith('/tips/orders')) {
      calls += 1;
      idempotencyKeys.push(String((init?.headers as Record<string, string>)['Idempotency-Key']));
      if (calls === 1) return new Response(JSON.stringify({ schemaVersion: 'v1', errorCode: 'payment_unavailable', message: 'temporary outage', retryable: true }), { status: 503 });
      return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000002', provider: 'razorpay', providerOrderId: 'order_retry_2', amountPaise: 10000, currency: 'INR', status: 'created' }), { status: 201 });
    }
    throw new Error(`unexpected ${String(url)}`);
  }) as typeof fetch;
  try {
    render(<TipForm handle="retry_failure_creator" acceptingTips minimumTipPaise={1000} />);
    const form = screen.getByRole('button', { name: /continue to tip/i }).closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /temporary outage/i));
    fireEvent.submit(form);
    await waitFor(() => assert.equal(calls, 2));
    assert.match(idempotencyKeys[0] ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(idempotencyKeys[1], idempotencyKeys[0]);
  } finally {
    globalThis.fetch = previousFetch;
    window.Razorpay = previousRazorpay;
  }
});
