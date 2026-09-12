import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

// DashboardClient's getCurrentUser() call is deliberately GATED behind a
// prior getTermsStatus() check (see useChannelBootstrap.ts's comment on
// bootstrapChannelUser and DashboardClient.tsx:39-48) — unlike every other
// AppShell-wrapped page, which fires getCurrentUser() unconditionally on
// mount via useChannelBootstrap. These tests would fail if that gating
// regressed to an unconditional call (or if a rejected/absent terms check
// stopped redirecting to /accept-terms).

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1',
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};
const baseChannel: api.ChannelDetails = {
  schemaVersion: 'v1', channelId: 'c1', handle: 'testhandle', displayName: 'Test Channel',
  acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner',
};
const baseBilling: api.BillingView = {
  schemaVersion: 'v1', channelId: 'c1', tier: 'free', monthlyPricePaise: 0, annualMonthsCharged: 0,
  annualServiceMonths: 0, renewalState: 'not_applicable', nextRenewalAt: null, billingInterval: 'monthly',
  autoRenew: false, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current',
};

let getCurrentUserCalls = 0;
const getTermsStatus = controllable<Parameters<typeof api.getTermsStatus>, Awaited<ReturnType<typeof api.getTermsStatus>>>(
  async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: getTermsStatus.fn,
  getCurrentUser: async () => { getCurrentUserCalls += 1; return baseUser; },
  getChannel: async () => baseChannel,
  getBilling: async () => baseBilling,
  getCompanionState: async () => ({ schemaVersion: 'v1', channelId: 'c1', overlayConnected: false, pendingAlerts: 0, lastUpdatedAt: '2026-01-01T00:00:00.000Z' }),
  getQueues: async () => ({ schemaVersion: 'v1', queues: [] }),
});

// jsdom's window.location.assign is a non-configurable, non-writable own
// property on the Location instance (deliberate jsdom hardening — cannot be
// monkey-patched/stubbed even via Object.defineProperty, confirmed by a
// TypeError at test-write time). Calling it in jsdom just logs an
// unimplemented-navigation warning to the virtual console and returns
// normally, without setting `user`/`channel` state — so the redirect branch
// is instead verified by its real, observable consequence: the component
// never advances past "Loading your channels…" (it would show the Welcome
// panel if bootstrapChannelUser's onUser ever ran).

test('terms rejected: getCurrentUser is NEVER called, and the component stays on the loading gate (never renders the dashboard) — the real effect of redirecting to /accept-terms', async () => {
  getCurrentUserCalls = 0;
  getTermsStatus.set(async () => ({ schemaVersion: 'v1', documents: [], accepted: false }));

  const { default: DashboardClient } = await import(`./DashboardClient?t=${Math.random()}`);
  render(<DashboardClient />);

  await waitFor(() => screen.getByText('Loading your channels…'));
  // Give any (incorrect) getCurrentUser call a chance to resolve and render.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(screen.queryByText('Welcome, Test Creator.'), null);
  assert.equal(getCurrentUserCalls, 0, 'getCurrentUser must stay gated behind the terms check, never fire unconditionally on mount');
});

test('getTermsStatus itself failing also fails closed — no getCurrentUser call, dashboard never renders', async () => {
  getCurrentUserCalls = 0;
  getTermsStatus.set(async () => { throw new Error('terms endpoint unavailable'); });

  const { default: DashboardClient } = await import(`./DashboardClient?t=${Math.random()}`);
  render(<DashboardClient />);

  await waitFor(() => screen.getByText('Loading your channels…'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(screen.queryByText('Welcome, Test Creator.'), null);
  assert.equal(getCurrentUserCalls, 0);
});

test('terms accepted: getCurrentUser DOES fire (via bootstrapChannelUser) and the dashboard renders', async () => {
  getCurrentUserCalls = 0;
  getTermsStatus.set(async () => ({ schemaVersion: 'v1', documents: [], accepted: true }));

  const { default: DashboardClient } = await import(`./DashboardClient?t=${Math.random()}`);
  render(<DashboardClient />);

  await waitFor(() => screen.getByText('Welcome, Test Creator.'));
  assert.equal(getCurrentUserCalls, 1);
});
