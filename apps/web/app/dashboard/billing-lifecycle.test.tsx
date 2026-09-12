import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import { baseBillingView } from '../test-support/fixtures';
import type * as api from '../lib/api';
import type { BillingActionsPanel as BillingActionsPanelType } from './BillingActionsPanel';

/*
 * BillingActionsPanel renders directly (no AppShell/page needed — it is a
 * pure props-in component). Every lifecycle call here is a redirect-or-
 * webhook-confirmed action: the panel itself must never collect card/CVV/
 * UPI data — see the "no instrument data" test below, which would fail if
 * a regression ever added a real payment input to this file.
 */

type Calls = { createSubscription: unknown[][]; upgradeSubscription: unknown[][]; downgradeSubscription: unknown[][]; cancelSubscription: unknown[][]; reactivateSubscription: unknown[][] };
const calls: Calls = { createSubscription: [], upgradeSubscription: [], downgradeSubscription: [], cancelSubscription: [], reactivateSubscription: [] };

const createSubscription = controllable<Parameters<typeof api.createSubscription>, Awaited<ReturnType<typeof api.createSubscription>>>(
  async () => { throw new Error('createSubscription not stubbed for this test'); },
);
const upgradeSubscription = controllable<Parameters<typeof api.upgradeSubscription>, Awaited<ReturnType<typeof api.upgradeSubscription>>>(
  async () => { throw new Error('upgradeSubscription not stubbed for this test'); },
);
const downgradeSubscription = controllable<Parameters<typeof api.downgradeSubscription>, Awaited<ReturnType<typeof api.downgradeSubscription>>>(
  async () => { throw new Error('downgradeSubscription not stubbed for this test'); },
);
const cancelSubscription = controllable<Parameters<typeof api.cancelSubscription>, Awaited<ReturnType<typeof api.cancelSubscription>>>(
  async () => { throw new Error('cancelSubscription not stubbed for this test'); },
);
const reactivateSubscription = controllable<Parameters<typeof api.reactivateSubscription>, Awaited<ReturnType<typeof api.reactivateSubscription>>>(
  async () => { throw new Error('reactivateSubscription not stubbed for this test'); },
);
const getBilling = controllable<Parameters<typeof api.getBilling>, Awaited<ReturnType<typeof api.getBilling>>>(async () => baseBillingView);

mockApi({
  getAccessToken: () => 'fake-token',
  createSubscription: (...args) => { calls.createSubscription.push(args); return createSubscription.fn(...args); },
  upgradeSubscription: (...args) => { calls.upgradeSubscription.push(args); return upgradeSubscription.fn(...args); },
  downgradeSubscription: (...args) => { calls.downgradeSubscription.push(args); return downgradeSubscription.fn(...args); },
  cancelSubscription: (...args) => { calls.cancelSubscription.push(args); return cancelSubscription.fn(...args); },
  reactivateSubscription: (...args) => { calls.reactivateSubscription.push(args); return reactivateSubscription.fn(...args); },
  getBilling: getBilling.fn,
});

function resetCalls() {
  for (const key of Object.keys(calls) as (keyof Calls)[]) calls[key] = [];
}

function lifecycleResult(action: api.SubscriptionLifecycleResult['action']): api.SubscriptionLifecycleResult {
  return { schemaVersion: 'v1', action, requestId: 'req-1', status: 'requested', replay: false };
}

// mockApi() only affects modules imported AFTER it runs — a static
// top-level `import { BillingActionsPanel } from './BillingActionsPanel'`
// would pull in the REAL lib/api before the mock.module() call above ever
// executes (import statements are hoisted ahead of this file's own
// top-level code). Loading it dynamically, once, after mockApi(), is what
// makes the component pick up the mocked lifecycle functions at all.
let PanelComponent: typeof BillingActionsPanelType | null = null;
async function loadPanel(): Promise<typeof BillingActionsPanelType> {
  if (!PanelComponent) {
    ({ BillingActionsPanel: PanelComponent } = await import('./BillingActionsPanel'));
  }
  return PanelComponent;
}

function assertNoInstrumentInputs(container: HTMLElement) {
  // The entire panel must never render a form input — every action here
  // is a button that either calls a lifecycle route or redirects into
  // Razorpay's own hosted flow. A regression that added ANY input (card
  // number, CVV, expiry, UPI VPA) inside this panel would be a serious
  // PCI-scope violation, so this checks for the absence of the element
  // kind entirely, not just specific field names.
  assert.equal(container.querySelectorAll('input, textarea').length, 0);
}

test('free tier shows all three paid plans as Subscribe buttons with the correct price, and collects no instrument data', async () => {
  const Panel = await loadPanel();
  const { container } = render(<Panel channelId="c1" billing={{ ...baseBillingView, tier: 'free' }} onUpdated={() => {}} />);
  assert.equal(screen.getAllByRole('button', { name: 'Subscribe' }).length, 3);
  assert.ok(screen.getByText(/Pro — ₹199\/mo/));
  assert.ok(screen.getByText(/Creator — ₹399\/mo/));
  assert.ok(screen.getByText(/Studio — ₹499\/mo/));
  assertNoInstrumentInputs(container);
});

test('subscribing calls createSubscription with the chosen tier and monthly interval — no card data leaves this component', async () => {
  resetCalls();
  createSubscription.set(async () => ({ schemaVersion: 'v1', provider: 'razorpay', status: 'pending', subscriptionId: 'sub_1', tier: 'pro', billingInterval: 'monthly', monthlyPricePaise: 19900, annualChargePaise: 19900, annualMonthsCharged: 1, annualServiceMonths: 1, checkoutUrl: 'https://rzp.io/i/abc' }));
  const Panel = await loadPanel();
  const { container } = render(<Panel channelId="c1" billing={{ ...baseBillingView, tier: 'free' }} onUpdated={() => {}} />);
  const proRow = screen.getByText(/Pro — ₹199\/mo/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(proRow).getByRole('button', { name: 'Subscribe' }));
  await waitFor(() => assert.equal(calls.createSubscription.length, 1));
  assert.deepEqual(calls.createSubscription[0], ['c1', 'pro', 'monthly']);
  assertNoInstrumentInputs(container);
});

test('a checkoutUrl outside the approved Razorpay allowlist is rejected client-side with an error, never followed', async () => {
  createSubscription.set(async () => ({ schemaVersion: 'v1', provider: 'razorpay', status: 'pending', subscriptionId: 'sub_2', tier: 'pro', billingInterval: 'monthly', monthlyPricePaise: 19900, annualChargePaise: 19900, annualMonthsCharged: 1, annualServiceMonths: 1, checkoutUrl: 'https://evil.example.com/phish' }));
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={{ ...baseBillingView, tier: 'free' }} onUpdated={() => {}} />);
  const proRow = screen.getByText(/Pro — ₹199\/mo/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(proRow).getByRole('button', { name: 'Subscribe' }));
  await waitFor(() => screen.getByText(/Invalid checkout URL/));
});

const paidActive: api.BillingView = { ...baseBillingView, tier: 'creator', renewalState: 'active', currentPeriodEndsAt: '2026-10-01T00:00:00.000Z' };

test('a paid (creator) tier shows upgrade to studio and downgrade to pro, with no instrument fields anywhere', async () => {
  const Panel = await loadPanel();
  const { container } = render(<Panel channelId="c1" billing={paidActive} onUpdated={() => {}} />);
  assert.ok(screen.getByText(/Upgrade to Studio/));
  assert.ok(screen.getByText(/Downgrade to Pro/));
  assertNoInstrumentInputs(container);
});

test('upgrade calls upgradeSubscription with the target tier and current billing interval', async () => {
  resetCalls();
  upgradeSubscription.set(async () => lifecycleResult('upgrade'));
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => {}} />);
  const row = screen.getByText(/Upgrade to Studio/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Upgrade' }));
  await waitFor(() => assert.equal(calls.upgradeSubscription.length, 1));
  assert.deepEqual(calls.upgradeSubscription[0], ['c1', 'studio', 'monthly']);
  await waitFor(() => screen.getByText(/Upgrading to Studio/));
});

test('downgrade requires an explicit confirm step before calling downgradeSubscription', async () => {
  resetCalls();
  downgradeSubscription.set(async () => lifecycleResult('downgrade'));
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => {}} />);
  const row = screen.getByText(/Downgrade to Pro/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Downgrade' }));

  // Not called yet — the confirm dialog is a real gate, not decoration.
  assert.equal(calls.downgradeSubscription.length, 0);
  assert.ok(screen.getByText(/Downgrade to Pro\?/));

  fireEvent.click(screen.getByRole('button', { name: 'Yes, downgrade' }));
  await waitFor(() => assert.equal(calls.downgradeSubscription.length, 1));
  assert.deepEqual(calls.downgradeSubscription[0], ['c1', 'pro', 'monthly']);
});

test('"Keep plan" dismisses the downgrade confirm without calling the API', async () => {
  resetCalls();
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => {}} />);
  const row = screen.getByText(/Downgrade to Pro/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Downgrade' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep plan' }));
  assert.equal(screen.queryByText(/Downgrade to Pro\?/), null);
  assert.equal(calls.downgradeSubscription.length, 0);
});

test('cancel requires an explicit confirm step before calling cancelSubscription, and warns no refund', async () => {
  resetCalls();
  cancelSubscription.set(async () => lifecycleResult('cancel'));
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
  assert.equal(calls.cancelSubscription.length, 0);
  assert.ok(screen.getByText(/No refund for unused time/));

  fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
  await waitFor(() => assert.equal(calls.cancelSubscription.length, 1));
  assert.deepEqual(calls.cancelSubscription[0], ['c1']);
});

const cancelledBilling: api.BillingView = { ...baseBillingView, tier: 'pro', renewalState: 'cancelled', currentPeriodEndsAt: '2026-10-05T00:00:00.000Z' };

test('a cancelled subscription shows Reactivate (not Subscribe), and reactivating calls reactivateSubscription', async () => {
  resetCalls();
  reactivateSubscription.set(async () => lifecycleResult('reactivate'));
  const Panel = await loadPanel();
  const { container } = render(<Panel channelId="c1" billing={cancelledBilling} onUpdated={() => {}} />);
  assert.ok(screen.getByText(/Plan ends/));
  assert.equal(screen.queryByRole('button', { name: 'Subscribe' }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
  await waitFor(() => assert.equal(calls.reactivateSubscription.length, 1));
  assert.deepEqual(calls.reactivateSubscription[0], ['c1']);
  await waitFor(() => screen.getByText(/Reactivating — your plan continues as normal/));
  assertNoInstrumentInputs(container);
});

const pastDueBilling: api.BillingView = { ...baseBillingView, tier: 'pro', renewalState: 'past_due', currentPeriodEndsAt: '2026-09-20T00:00:00.000Z' };

test('past-due shows "Payment failed" with Retry payment and Update payment method — retrying calls reactivateSubscription, no instrument input rendered', async () => {
  resetCalls();
  reactivateSubscription.set(async () => lifecycleResult('reactivate'));
  const Panel = await loadPanel();
  const { container } = render(<Panel channelId="c1" billing={pastDueBilling} onUpdated={() => {}} />);
  assert.ok(screen.getByText('Payment failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry payment' }));
  await waitFor(() => assert.equal(calls.reactivateSubscription.length, 1));
  await waitFor(() => screen.getByText(/Retrying your payment/));
  assertNoInstrumentInputs(container);
});

test('a failed lifecycle call surfaces its error text and does not call onUpdated', async () => {
  resetCalls();
  upgradeSubscription.set(async () => { throw new Error('Payment provider rejected the request'); });
  let updated = false;
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => { updated = true; }} />);
  const row = screen.getByText(/Upgrade to Studio/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Upgrade' }));
  await waitFor(() => screen.getByText('Payment provider rejected the request'));
  assert.equal(updated, false);
});
