import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';

// getApiOrigin (apps/web/app/lib/api-origin.ts, not this task's file) falls
// back to http://localhost:4100 only for 'development'/'test' — the test
// runner does not set NODE_ENV itself, so this test sets it directly
// rather than editing that shared file.
// @types/node declares NODE_ENV read-only, and TS narrows the index signature
// to the same declared property, so both `process.env.NODE_ENV = ...` and
// `process.env['NODE_ENV'] = ...` are rejected. Mutating the env object through
// a widened alias is the assignment TypeScript will accept.
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner' as const, payoutOnboardingDone: true }],
};

const pastDueBilling = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  tier: 'pro' as const,
  monthlyPricePaise: 19900,
  annualMonthsCharged: 1,
  annualServiceMonths: 1,
  renewalState: 'past_due' as const,
  nextRenewalAt: null,
  billingInterval: 'monthly' as const,
  autoRenew: true,
  currentPeriodEndsAt: '2026-09-20T00:00:00.000Z',
  priceProtectedUntil: null,
  priceSource: 'current' as const,
};

function withShellDefaults(overrides: Parameters<typeof mockApi>[0]) {
  mockApi({
    getAccessToken: () => 'fake-token',
    getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
    getChannel: async () => ({ schemaVersion: 'v1', channelId: 'c1', handle: 'test', displayName: 'Test', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' }),
    getBilling: async () => pastDueBilling,
    getCurrentUser: async () => baseUser,
    ...overrides,
  });
}

test('past-due billing page shows a real "Update payment method" path, not a support-email dead end', async () => {
  withShellDefaults({});
  const { default: BillingPage } = await import(`./billing/page?t=${Date.now()}-1`);
  render(<BillingPage />);
  await waitFor(() => assert.ok(screen.getByText(/Payment failed/)));
  assert.ok(screen.getByRole('button', { name: /Update payment method/ }));
  assert.equal(screen.queryByText(/email support@bharatstudio\.in/), null);
});

test('clicking "Update payment method" calls the payment-method endpoint with an idempotency key and no instrument data, never touching lib/api', async () => {
  withShellDefaults({});
  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({ schemaVersion: 'v1', provider: 'razorpay', updateUrl: 'https://rzp.io/i/update-abc', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
  }) as typeof fetch;

  try {
    const { default: BillingPage } = await import(`./billing/page?t=${Date.now()}-2`);
    render(<BillingPage />);
    await waitFor(() => assert.ok(screen.getByText(/Payment failed/)));
    fireEvent.click(screen.getByRole('button', { name: /Update payment method/ }));
    await waitFor(() => assert.equal(calls.length, 1));
    const call = calls[0]!;
    assert.match(call.url, /\/v1\/channels\/c1\/billing\/payment-method$/);
    assert.equal(call.init.method, 'POST');
    const headers = new Headers(call.init.headers);
    assert.ok(headers.get('idempotency-key'));
    assert.equal(call.init.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
