import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import { baseBillingView } from '../test-support/fixtures';
import type * as api from '../lib/api';
import type { BillingActionsPanel as BillingActionsPanelType } from './BillingActionsPanel';

/*
 * Covers BillingActionsPanel's refreshBillingSoon(): a lifecycle action
 * (upgrade here) must trigger a SECOND, delayed (2s) call to getBilling
 * and feed its result to onUpdated — not just show the immediate
 * optimistic notice.
 *
 * Timer approach: grepping the repo (useFakeTimers/sinon/mock.timers) found
 * no existing fake-timer usage. node:test's `mock.timers` (available on
 * this Node 24) was tried first, but enabling it globally intercepts the
 * setTimeout @testing-library's own `waitFor` polls with internally,
 * deadlocking every `waitFor` call in the same test (confirmed by an
 * isolated repro: the test hung indefinitely with `--test-timeout=0`).
 * Scoping `mock.timers` to only the component's own setTimeout was not
 * possible without an injectable timer seam in BillingActionsPanel itself,
 * which is a source change out of scope for this test-only task. So this
 * file uses a real, short (2.1s) wait past the actual 2000ms delay instead
 * — slower than a fake-timer advance, but deterministic and doesn't touch
 * RTL's own timer usage.
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const upgradeSubscription = controllable<Parameters<typeof api.upgradeSubscription>, Awaited<ReturnType<typeof api.upgradeSubscription>>>(
  async () => ({ schemaVersion: 'v1', action: 'upgrade', requestId: 'req-1', status: 'requested', replay: false }),
);
const getBillingCalls: unknown[][] = [];
const getBilling = controllable<Parameters<typeof api.getBilling>, Awaited<ReturnType<typeof api.getBilling>>>(async () => baseBillingView);

mockApi({
  getAccessToken: () => 'fake-token',
  upgradeSubscription: (...args) => upgradeSubscription.fn(...args),
  getBilling: (...args) => { getBillingCalls.push(args); return getBilling.fn(...args); },
});

let PanelComponent: typeof BillingActionsPanelType | null = null;
async function loadPanel(): Promise<typeof BillingActionsPanelType> {
  if (!PanelComponent) {
    ({ BillingActionsPanel: PanelComponent } = await import('./BillingActionsPanel'));
  }
  return PanelComponent;
}

const paidActive: api.BillingView = { ...baseBillingView, tier: 'creator', renewalState: 'active', currentPeriodEndsAt: '2026-10-01T00:00:00.000Z' };

test('an upgrade does not re-fetch billing immediately alongside the optimistic notice — the refetch is gated behind the 2s delay', { timeout: 10000 }, async () => {
  getBillingCalls.length = 0;
  upgradeSubscription.set(async () => ({ schemaVersion: 'v1', action: 'upgrade', requestId: 'req-2', status: 'requested', replay: false }));
  getBilling.set(async () => ({ ...paidActive, tier: 'studio' }));

  let updated: api.BillingView | null = null;
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={(next) => { updated = next; }} />);

  const row = screen.getByText(/Upgrade to Studio/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Upgrade' }));

  await waitFor(() => screen.getByText(/Upgrading to Studio/));
  // Immediately after the optimistic notice, the delayed refetch must not
  // have fired yet — this is what proves refreshBillingSoon() is gated
  // behind a real delay and not called eagerly alongside the notice.
  assert.equal(getBillingCalls.length, 0);
  assert.equal(updated, null);

  // Drain the pending 2s timer before the test ends, so it can't fire
  // during (and pollute the call count of) the next test.
  await wait(2100);
});

test('after the 2s delay elapses, refreshBillingSoon re-fetches billing and feeds the fresh result to onUpdated', { timeout: 10000 }, async () => {
  getBillingCalls.length = 0;
  const refreshedBilling: api.BillingView = { ...paidActive, tier: 'studio' };
  upgradeSubscription.set(async () => ({ schemaVersion: 'v1', action: 'upgrade', requestId: 'req-3', status: 'requested', replay: false }));
  getBilling.set(async () => refreshedBilling);

  let updated: api.BillingView | null = null;
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={(next) => { updated = next; }} />);

  const row = screen.getByText(/Upgrade to Studio/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Upgrade' }));
  await waitFor(() => screen.getByText(/Upgrading to Studio/));

  await wait(2100);

  assert.equal(getBillingCalls.length, 1);
  assert.deepEqual(getBillingCalls[0], ['c1']);
  assert.equal((updated as unknown as api.BillingView | null)?.tier, 'studio');
});

test('if the delayed getBilling() refetch itself fails, onUpdated is never called and no error surfaces — the panel stays on its optimistic notice', { timeout: 10000 }, async () => {
  getBillingCalls.length = 0;
  upgradeSubscription.set(async () => ({ schemaVersion: 'v1', action: 'upgrade', requestId: 'req-4', status: 'requested', replay: false }));
  getBilling.set(async () => { throw new Error('billing read failed'); });

  let updated = false;
  const Panel = await loadPanel();
  render(<Panel channelId="c1" billing={paidActive} onUpdated={() => { updated = true; }} />);

  const row = screen.getByText(/Upgrade to Studio/).closest('.channel-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Upgrade' }));
  await waitFor(() => screen.getByText(/Upgrading to Studio/));

  await wait(2100);

  assert.equal(getBillingCalls.length, 1);
  assert.equal(updated, false);
  // The best-effort-refresh failure must not replace the optimistic notice
  // with an error message.
  assert.ok(screen.getByText(/Upgrading to Studio/));
  assert.equal(screen.queryByText('billing read failed'), null);
});
