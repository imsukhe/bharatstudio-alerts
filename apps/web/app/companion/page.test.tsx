import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

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

const notificationPrefs: api.NotificationPreferences = { schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: true };

const getCurrentUser = controllable<Parameters<typeof api.getCurrentUser>, Awaited<ReturnType<typeof api.getCurrentUser>>>(async () => baseUser);
const getEntitlements = controllable<Parameters<typeof api.getEntitlements>, Awaited<ReturnType<typeof api.getEntitlements>>>(
  async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'pro', source: 'individual_plan', entitlementVersion: 1, values: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] } }),
);
const getCompanionLayout = controllable<Parameters<typeof api.getCompanionLayout>, Awaited<ReturnType<typeof api.getCompanionLayout>>>(async () => baseLayout);
const updateCompanionLayout = controllable<Parameters<typeof api.updateCompanionLayout>, Awaited<ReturnType<typeof api.updateCompanionLayout>>>(
  async () => { throw new Error('updateCompanionLayout not stubbed for this test'); },
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: getCurrentUser.fn,
  getChannel: async () => ({ schemaVersion: 'v1', channelId: 'c1', handle: 'test', displayName: 'Test', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' }),
  getBilling: async () => baseBilling,
  getCompanionState: async () => baseState,
  getCompanionLayout: getCompanionLayout.fn,
  updateCompanionLayout: updateCompanionLayout.fn,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [activeQueue] }),
  getHistory: async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }),
  getSessions: async () => ({ schemaVersion: 'v1', sessions: [] }),
  getNotificationPreferences: async () => notificationPrefs,
  getEntitlements: getEntitlements.fn,
  executeCompanionAction: async () => { throw new Error('executeCompanionAction not stubbed for this test'); },
  revokeSession: async () => { throw new Error('revokeSession not stubbed for this test'); },
  updateNotificationPreferences: async () => notificationPrefs,
  clearAccessToken: () => {},
  notificationPreferencesInput: (value: api.NotificationPreferences) => ({ connectionAlerts: value.connectionAlerts, securityAlerts: value.securityAlerts, actionFailures: value.actionFailures }),
});

async function renderFreshPage() {
  const { default: CompanionPage } = await import(`./page?t=${Math.random()}`);
  render(<CompanionPage />);
  // Wait for both the page's own bootstrap and AppShell's independent
  // identity/bootstrap effect. Without this, node:test can clean up the
  // tree while those promises still schedule React state updates, producing
  // misleading act() warnings despite assertions passing.
  await waitFor(() => screen.getByText('@test'));
}

test('when the entitlements fetch fails (e.g. a Companion-only channel with no entitlement row), Alerts locks but OBS/Mirror/Stream stay available — matching the server-side NO_ALERTS_ENTITLED_GROUPS fallback, not "unknown"', async () => {
  getCurrentUser.set(async () => baseUser);
  getEntitlements.set(async () => { throw new Error('no entitlement row for this channel'); });
  getCompanionLayout.set(async () => baseLayout);
  await renderFreshPage();

  await waitFor(() => screen.getByText('Add an action to a slot'));
  const lockedRow = screen.getAllByText('Pause queue').map((el) => el.closest('.companion-catalogue-row')).find(Boolean) as HTMLElement;
  const availableRow = screen.getByText('Start Mirror').closest('.companion-catalogue-row') as HTMLElement;
  assert.equal(lockedRow.getAttribute('data-gate'), 'locked');
  assert.equal(availableRow.getAttribute('data-gate'), 'available');
});

test('a layout version conflict (PATCH rejected 409) is rendered as a real recoverable state, not a crash', async () => {
  getCurrentUser.set(async () => baseUser);
  getEntitlements.set(async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'pro', source: 'individual_plan', entitlementVersion: 1, values: {} }));
  getCompanionLayout.set(async () => baseLayout);
  updateCompanionLayout.set(async () => { throw new Error('version conflict: layout changed'); });
  const serverLayout: api.CompanionLayout = { ...baseLayout, version: 4, slots: [{ slotIndex: 1, page: 1, label: 'Someone else added this', action: 'mirror_start', targetId: '22222222-2222-2222-2222-222222222222' }] };
  let secondFetch = false;
  const originalGetLayout = getCompanionLayout;
  await renderFreshPage();

  await waitFor(() => screen.getByText('Save layout'));
  // Simulate the conflict path by swapping getCompanionLayout's fixture for
  // what the retry-fetch-after-409 branch reads, then triggering the save.
  getCompanionLayout.set(async () => { secondFetch = true; return serverLayout; });
  fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

  // The page must not crash or silently discard the operator's view — it
  // shows the server's real current version/slot count and a way forward.
  // (Both the status banner and the conflict panel say "Someone else saved
  // a newer Companion layout" — two distinct elements confirm this landed
  // as a real recoverable UI state, not a silent failure or a crash.)
  await waitFor(() => assert.equal(screen.getAllByText(/someone else saved a newer companion layout/i).length, 2));
  assert.ok(screen.getByText(/now at version 4, 1 slot\(s\)/i));
  assert.ok(screen.getByRole('button', { name: 'Reload latest layout' }));
  assert.equal(secondFetch, true);
  void originalGetLayout;
});

test('reloading from a layout conflict adopts the server layout and clears the conflict banner', async () => {
  getCurrentUser.set(async () => baseUser);
  getEntitlements.set(async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'pro', source: 'individual_plan', entitlementVersion: 1, values: {} }));
  getCompanionLayout.set(async () => baseLayout);
  updateCompanionLayout.set(async () => { throw new Error('version conflict: layout changed'); });
  const serverLayout: api.CompanionLayout = { ...baseLayout, version: 5, slots: [{ slotIndex: 1, page: 1, label: 'Server slot', action: 'mirror_start', targetId: '33333333-3333-3333-3333-333333333333' }] };
  await renderFreshPage();

  await waitFor(() => screen.getByText('Save layout'));
  getCompanionLayout.set(async () => serverLayout);
  fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
  await waitFor(() => screen.getByRole('button', { name: 'Reload latest layout' }));

  fireEvent.click(screen.getByRole('button', { name: 'Reload latest layout' }));
  await waitFor(() => screen.getByText((_, element) => element?.tagName === 'STRONG' && (element.textContent ?? '').includes('Server slot')));
  assert.equal(screen.queryByText(/someone else saved a newer companion layout/i), null);
});

test('the slot ladder shows this tier\'s maxSlots and only offers page sizes that fit within it', async () => {
  getCurrentUser.set(async () => baseUser);
  getEntitlements.set(async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'free', source: 'individual_plan', entitlementVersion: 1, values: {} }));
  getCompanionLayout.set(async () => ({ ...baseLayout, tier: 'free', maxSlots: 8, pageSize: 4 }));
  await renderFreshPage();

  await waitFor(() => screen.getByText('0/8 slots'));
  const pageSizeSelect = screen.getByLabelText('Buttons per page') as HTMLSelectElement;
  const offered = Array.from(pageSizeSelect.options).map((option) => option.value);
  assert.deepEqual(offered, ['4', '8']); // 16 is excluded — it exceeds this tier's maxSlots of 8
});
