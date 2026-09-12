import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';
import { baseBillingView, baseChannelDetails } from '../test-support/fixtures';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'viewer' as const, payoutOnboardingDone: true }],
};

const currentUser = controllable<Parameters<typeof api.getCurrentUser>, Awaited<ReturnType<typeof api.getCurrentUser>>>(async () => baseUser);
const payments = controllable<Parameters<typeof api.getPayments>, Awaited<ReturnType<typeof api.getPayments>>>(
  async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }),
);

// mockApi(...) runs exactly ONCE for this whole file, before any test
// imports the page — see controllable.ts for why. AppShell's own sidebar
// fetch (getTermsStatus/getBilling/getChannel/getAccessToken) never varies
// across these tests, so it's mocked directly with fixed fixtures here.
mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getChannel: async () => baseChannelDetails('viewer'),
  getCurrentUser: currentUser.fn,
  getPayments: payments.fn,
});

async function renderFreshPaymentsPage(waitForShell = true) {
  const { default: PaymentsPage } = await import(`./page?t=${Math.random()}`);
  render(<PaymentsPage />);
  if (waitForShell) await waitFor(() => screen.getByText('@testhandle'));
}

test('shows Loading… before the bootstrap fetch resolves, then the real content after', async () => {
  let resolveUser: (value: typeof baseUser) => void = () => {};
  const pendingUser = new Promise<typeof baseUser>((resolve) => { resolveUser = resolve; });
  // The page and AppShell both call getCurrentUser. One shared promise keeps
  // the test's loading transition deterministic and fully settled.
  currentUser.set(async () => pendingUser);
  await renderFreshPaymentsPage(false);
  assert.equal(screen.getByRole('status').textContent, 'Loading…');
  await act(async () => { resolveUser(baseUser); }); // role: 'viewer' — resolves into the permission message, not the ledger
  await waitFor(() => screen.getByText(/Only the channel owner or an admin can view the payment ledger/));
  await waitFor(() => screen.getByText('@testhandle'));
});

test('shows the sign-in error state when the initial bootstrap fetch fails', async () => {
  currentUser.set(async () => { throw new Error('Authentication required'); });
  await renderFreshPaymentsPage(false);
  await waitFor(() => screen.getByRole('alert'));
  await waitFor(() => screen.getByText('Not signed in'));
  assert.equal(screen.getByRole('alert').textContent, 'Authentication required');
  assert.ok(screen.getByText(/Return to sign in/));
});

test('a viewer-role channel member sees the permission message, not the ledger or CSV export', async () => {
  currentUser.set(async () => baseUser); // role: 'viewer'
  payments.set(async () => { throw new Error('should not be called for a non-viewing role'); });
  await renderFreshPaymentsPage();
  await waitFor(() => screen.getByText(/Only the channel owner or an admin can view the payment ledger/));
  assert.equal(screen.queryByText(/Download CSV/), null);
});

test('an owner sees the ledger table and an empty-ledger message when there are no payments', async () => {
  currentUser.set(async () => ({ ...baseUser, channels: [{ ...baseUser.channels[0], role: 'owner' as const }] }));
  payments.set(async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }));
  await renderFreshPaymentsPage();
  await waitFor(() => screen.getByText('No payments yet.'));
  assert.ok(screen.getByText('0 payments loaded'));
});

test('an owner with payments sees each row rendered in the ledger table', async () => {
  currentUser.set(async () => ({ ...baseUser, channels: [{ ...baseUser.channels[0], role: 'admin' as const }] }));
  payments.set(async () => ({
    schemaVersion: 'v1',
    items: [{
      paymentId: 'p1', providerPaymentId: 'pay_ABC123', grossAmountPaise: 150000,
      currency: 'INR' as const, status: 'captured' as const, createdAt: '2026-01-01T00:00:00.000Z',
      refundTotalPaise: 0, latestRefundStatus: null,
    }],
    nextCursor: null,
  }));
  await renderFreshPaymentsPage();
  await waitFor(() => screen.getByText('pay_ABC123'));
  assert.ok(screen.getByText('₹1,500.00'));
  assert.ok(screen.getByRole('button', { name: 'Download CSV' }));
});
