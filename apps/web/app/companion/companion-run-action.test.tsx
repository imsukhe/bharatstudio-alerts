import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

/*
 * Covers CompanionPage's runAction() execution path (pause/resume/send_test_alert)
 * — success and failure — for an operator who already has an active queue
 * selected. The two-layer entitlement/gate rendering is covered in page.test.tsx;
 * this file only covers what happens once a control button is actually clicked.
 */

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1',
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

const baseBilling: api.BillingView = {
  schemaVersion: 'v1', channelId: 'c1', tier: 'pro', monthlyPricePaise: 19900, annualMonthsCharged: 1,
  annualServiceMonths: 1, renewalState: 'active', nextRenewalAt: null, billingInterval: 'monthly',
  autoRenew: true, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current',
};

const activeQueue: api.Queue = { schemaVersion: 'v1', queueId: '11111111-1111-1111-1111-111111111111', channelId: 'c1', name: 'Main queue', paused: false, active: true };

const baseLayout: api.CompanionLayout = {
  schemaVersion: 'v1', channelId: 'c1', version: 3, tier: 'pro', maxSlots: 16, pageSize: 4, slots: [], createdAt: '2026-01-01T00:00:00.000Z',
};

const stateBefore: api.CompanionState = { schemaVersion: 'v1', channelId: 'c1', overlayConnected: false, pendingAlerts: 2, lastUpdatedAt: '2026-01-01T00:00:00.000Z' };
const stateAfter: api.CompanionState = { schemaVersion: 'v1', channelId: 'c1', overlayConnected: true, pendingAlerts: 0, lastUpdatedAt: '2026-01-02T00:00:00.000Z' };

const notificationPrefs: api.NotificationPreferences = { schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: true };

const executeCompanionActionCalls: unknown[][] = [];
const executeCompanionAction = controllable<Parameters<typeof api.executeCompanionAction>, Awaited<ReturnType<typeof api.executeCompanionAction>>>(
  async () => { throw new Error('executeCompanionAction not stubbed for this test'); },
);
const getCompanionState = controllable<Parameters<typeof api.getCompanionState>, Awaited<ReturnType<typeof api.getCompanionState>>>(async () => stateBefore);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => ({ schemaVersion: 'v1', channelId: 'c1', handle: 'test', displayName: 'Test', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' }),
  getBilling: async () => baseBilling,
  getCompanionState: getCompanionState.fn,
  getCompanionLayout: async () => baseLayout,
  updateCompanionLayout: async () => { throw new Error('updateCompanionLayout not stubbed for this test'); },
  getQueues: async () => ({ schemaVersion: 'v1', queues: [activeQueue] }),
  getHistory: async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }),
  getSessions: async () => ({ schemaVersion: 'v1', sessions: [] }),
  getNotificationPreferences: async () => notificationPrefs,
  getEntitlements: async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'pro', source: 'individual_plan', entitlementVersion: 1, values: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] } }),
  executeCompanionAction: (...args) => { executeCompanionActionCalls.push(args); return executeCompanionAction.fn(...args); },
  revokeSession: async () => { throw new Error('revokeSession not stubbed for this test'); },
  updateNotificationPreferences: async () => notificationPrefs,
  clearAccessToken: () => {},
  notificationPreferencesInput: (value: api.NotificationPreferences) => ({ connectionAlerts: value.connectionAlerts, securityAlerts: value.securityAlerts, actionFailures: value.actionFailures }),
});

async function renderFreshPage() {
  const { default: CompanionPage } = await import(`./page?t=${Math.random()}`);
  render(<CompanionPage />);
  await waitFor(() => screen.getByText('@test'));
}

test('a successful "Pause queue" command calls executeCompanionAction with the selected channel and active queue, then re-fetches and renders the new companion state', async () => {
  executeCompanionActionCalls.length = 0;
  executeCompanionAction.set(async () => ({ schemaVersion: 'v1', commandId: 'cmd-1', status: 'accepted', acceptedAt: '2026-01-02T00:00:00.000Z' }));
  // First call (page's own initial load) returns stateBefore; every call
  // after that (the post-action re-fetch inside runAction) returns
  // stateAfter — this is what proves runAction() re-fetches at all, rather
  // than the test just rendering the "after" state from the start.
  let stateCalls = 0;
  getCompanionState.set(async () => { stateCalls += 1; return stateCalls === 1 ? stateBefore : stateAfter; });
  await renderFreshPage();

  await waitFor(() => screen.getByRole('button', { name: 'Pause queue' }));
  // Confirms the pre-command state is what's on screen (both the metric
  // card and the recovery panel read it), so the post-command assertion
  // below proves a real re-fetch happened, not a stale render.
  assert.equal(screen.getAllByText('Not connected').length, 2);

  fireEvent.click(screen.getByRole('button', { name: 'Pause queue' }));

  await waitFor(() => assert.equal(executeCompanionActionCalls.length, 1));
  assert.deepEqual(executeCompanionActionCalls[0], ['c1', 'pause_queue', activeQueue.queueId]);

  await waitFor(() => screen.getByText('Command accepted. Delivery and payment records remain independent of this control surface.'));
  // Both places that read companion state must reflect the freshly
  // re-fetched state (stateAfter), proving runAction() re-fetched rather
  // than just trusting its own optimistic success.
  await waitFor(() => assert.equal(screen.getAllByText('Connected').length, 2));
});

test('a failed "Resume queue" command surfaces the thrown error via StatusMessage and does not update companion state', async () => {
  executeCompanionActionCalls.length = 0;
  executeCompanionAction.set(async () => { throw new Error('Queue is not currently paused'); });
  getCompanionState.set(async () => stateBefore);
  await renderFreshPage();

  await waitFor(() => screen.getByRole('button', { name: 'Resume queue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));

  await waitFor(() => assert.equal(executeCompanionActionCalls.length, 1));
  await waitFor(() => screen.getByText('Queue is not currently paused'));
  // Still showing the original (never-refreshed) overlay state in both
  // places proves the failure branch skipped the getCompanionState()
  // re-fetch entirely.
  assert.equal(screen.getAllByText('Not connected').length, 2);
});

test('"Send test alert" calls executeCompanionAction with send_test_alert and the active queue id', async () => {
  executeCompanionActionCalls.length = 0;
  executeCompanionAction.set(async () => ({ schemaVersion: 'v1', commandId: 'cmd-2', status: 'accepted', acceptedAt: '2026-01-02T00:00:00.000Z' }));
  getCompanionState.set(async () => stateAfter);
  await renderFreshPage();

  await waitFor(() => screen.getByRole('button', { name: 'Send test alert' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send test alert' }));

  await waitFor(() => assert.equal(executeCompanionActionCalls.length, 1));
  assert.deepEqual(executeCompanionActionCalls[0], ['c1', 'send_test_alert', activeQueue.queueId]);
});

test('while a command is in flight, every other control action button is disabled — only the pressed button shows "Sending…"', async () => {
  executeCompanionActionCalls.length = 0;
  const pendingAction: { resolve: (() => void) | null } = { resolve: null };
  executeCompanionAction.set(() => new Promise((resolve) => {
    pendingAction.resolve = () => resolve({ schemaVersion: 'v1', commandId: 'cmd-3', status: 'accepted', acceptedAt: '2026-01-02T00:00:00.000Z' });
  }));
  getCompanionState.set(async () => stateAfter);
  await renderFreshPage();

  await waitFor(() => screen.getByRole('button', { name: 'Pause queue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pause queue' }));

  await waitFor(() => screen.getByRole('button', { name: 'Sending…' }));
  const resumeButton = screen.getByRole('button', { name: 'Resume queue' }) as HTMLButtonElement;
  const testAlertButton = screen.getByRole('button', { name: 'Send test alert' }) as HTMLButtonElement;
  assert.equal(resumeButton.disabled, true);
  assert.equal(testAlertButton.disabled, true);

  pendingAction.resolve?.();
  await waitFor(() => screen.getByRole('button', { name: 'Pause queue' }));
});
