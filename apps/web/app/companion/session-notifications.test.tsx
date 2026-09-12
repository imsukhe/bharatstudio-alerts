import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

/*
 * Covers CompanionPage's session-revoke panel (closeSession) and
 * notification-preference checkboxes (saveNotificationPreferences).
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

const baseState: api.CompanionState = { schemaVersion: 'v1', channelId: 'c1', overlayConnected: true, pendingAlerts: 0, lastUpdatedAt: '2026-01-01T00:00:00.000Z' };

const currentSession: api.AccountSession = { sessionId: 's-current', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z', current: true, deviceLabel: 'This browser' };
const otherSession: api.AccountSession = { sessionId: 's-other', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T12:00:00.000Z', current: false, deviceLabel: 'Old phone' };

const notificationPrefs: api.NotificationPreferences = { schemaVersion: 'v1', connectionAlerts: true, securityAlerts: false, actionFailures: true };

const getSessions = controllable<Parameters<typeof api.getSessions>, Awaited<ReturnType<typeof api.getSessions>>>(
  async () => ({ schemaVersion: 'v1', sessions: [currentSession, otherSession] }),
);
const revokeSessionCalls: unknown[][] = [];
const revokeSession = controllable<Parameters<typeof api.revokeSession>, Awaited<ReturnType<typeof api.revokeSession>>>(
  async () => { throw new Error('revokeSession not stubbed for this test'); },
);
const updateNotificationPreferencesCalls: unknown[][] = [];
const updateNotificationPreferences = controllable<Parameters<typeof api.updateNotificationPreferences>, Awaited<ReturnType<typeof api.updateNotificationPreferences>>>(
  async () => { throw new Error('updateNotificationPreferences not stubbed for this test'); },
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => ({ schemaVersion: 'v1', channelId: 'c1', handle: 'test', displayName: 'Test', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' }),
  getBilling: async () => baseBilling,
  getCompanionState: async () => baseState,
  getCompanionLayout: async () => baseLayout,
  updateCompanionLayout: async () => { throw new Error('updateCompanionLayout not stubbed for this test'); },
  getQueues: async () => ({ schemaVersion: 'v1', queues: [activeQueue] }),
  getHistory: async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }),
  getSessions: getSessions.fn,
  getNotificationPreferences: async () => notificationPrefs,
  getEntitlements: async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'pro', source: 'individual_plan', entitlementVersion: 1, values: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] } }),
  executeCompanionAction: async () => { throw new Error('executeCompanionAction not stubbed for this test'); },
  revokeSession: (...args) => { revokeSessionCalls.push(args); return revokeSession.fn(...args); },
  updateNotificationPreferences: (...args) => { updateNotificationPreferencesCalls.push(args); return updateNotificationPreferences.fn(...args); },
  clearAccessToken: () => {},
  notificationPreferencesInput: (value: api.NotificationPreferences) => ({ connectionAlerts: value.connectionAlerts, securityAlerts: value.securityAlerts, actionFailures: value.actionFailures }),
});

async function renderFreshPage() {
  const { default: CompanionPage } = await import(`./page?t=${Math.random()}`);
  const rendered = render(<CompanionPage />);
  await waitFor(() => screen.getByText('@test'));
  return rendered;
}

test('the current session never gets a Revoke button on the Companion page — only other sessions do', async () => {
  getSessions.set(async () => ({ schemaVersion: 'v1', sessions: [currentSession, otherSession] }));
  const { container } = await renderFreshPage();
  await waitFor(() => screen.getByText('Old phone'));

  const rows = Array.from(container.querySelectorAll('.session-list .session-row'));
  assert.equal(rows.length, 2);
  const currentRow = rows.find((row) => (row.textContent ?? '').includes('current')) as HTMLElement;
  const otherRow = rows.find((row) => (row.textContent ?? '').includes('Old phone')) as HTMLElement;
  assert.equal(currentRow.querySelector('button'), null);
  assert.ok(otherRow.querySelector('button'));
  assert.equal(otherRow.querySelector('button')?.textContent, 'Revoke');
});

test('revoking a non-current session calls revokeSession with that session id and removes only that row', async () => {
  revokeSessionCalls.length = 0;
  getSessions.set(async () => ({ schemaVersion: 'v1', sessions: [currentSession, otherSession] }));
  revokeSession.set(async () => undefined);
  await renderFreshPage();
  await waitFor(() => screen.getByText('Old phone'));

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => assert.equal(revokeSessionCalls.length, 1));
  assert.deepEqual(revokeSessionCalls[0], ['s-other']);
  await waitFor(() => assert.equal(screen.queryByText('Old phone'), null));
  // The other row survives the removal — proves the filter targeted the
  // right session id, not a blanket clear of the session list.
  assert.ok(screen.getByText((_, element) => element?.tagName === 'STRONG' && (element.textContent ?? '').includes('This browser')));
  await waitFor(() => screen.getByText('Session revoked. Any cached client access must authenticate again.'));
});

test('a failed session revoke shows the error and leaves the session in the list (no optimistic removal)', async () => {
  revokeSessionCalls.length = 0;
  getSessions.set(async () => ({ schemaVersion: 'v1', sessions: [currentSession, otherSession] }));
  revokeSession.set(async () => { throw new Error('Session already expired'); });
  await renderFreshPage();
  await waitFor(() => screen.getByText('Old phone'));

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => assert.equal(revokeSessionCalls.length, 1));
  await waitFor(() => screen.getByText('Session already expired'));
  // Still present — a failed revoke must not have removed the row.
  assert.ok(screen.getByText('Old phone'));
});

test('toggling a notification-preference checkbox calls updateNotificationPreferences with only that field flipped, and re-renders the saved server response', async () => {
  updateNotificationPreferencesCalls.length = 0;
  updateNotificationPreferences.set(async () => ({ schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: true }));
  await renderFreshPage();
  await waitFor(() => screen.getByLabelText('Security events'));

  const checkbox = screen.getByLabelText('Security events') as HTMLInputElement;
  assert.equal(checkbox.checked, false);
  fireEvent.click(checkbox);

  await waitFor(() => assert.equal(updateNotificationPreferencesCalls.length, 1));
  assert.deepEqual(updateNotificationPreferencesCalls[0], [{ connectionAlerts: true, securityAlerts: true, actionFailures: true }]);
  await waitFor(() => screen.getByText('Notification preferences saved on the server.'));
  await waitFor(() => assert.equal((screen.getByLabelText('Security events') as HTMLInputElement).checked, true));
});

test('all notification checkboxes are disabled while a save is in flight, and re-enabled after', async () => {
  updateNotificationPreferencesCalls.length = 0;
  const control: { resolve: (() => void) | null } = { resolve: null };
  updateNotificationPreferences.set(() => new Promise((resolve) => {
    control.resolve = () => resolve({ schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: true });
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByLabelText('Security events'));

  fireEvent.click(screen.getByLabelText('Security events'));
  await waitFor(() => assert.equal((screen.getByLabelText('Connection changes') as HTMLInputElement).disabled, true));
  assert.equal((screen.getByLabelText('Action failures') as HTMLInputElement).disabled, true);

  control.resolve?.();
  await waitFor(() => assert.equal((screen.getByLabelText('Connection changes') as HTMLInputElement).disabled, false));
});

test('a failed notification-preference save shows the error and does not flip the checkbox', async () => {
  updateNotificationPreferencesCalls.length = 0;
  updateNotificationPreferences.set(async () => { throw new Error('Preferences could not be saved right now'); });
  await renderFreshPage();
  await waitFor(() => screen.getByLabelText('Security events'));

  fireEvent.click(screen.getByLabelText('Security events'));

  await waitFor(() => assert.equal(updateNotificationPreferencesCalls.length, 1));
  await waitFor(() => screen.getByText('Preferences could not be saved right now'));
  assert.equal((screen.getByLabelText('Security events') as HTMLInputElement).checked, false);
});
