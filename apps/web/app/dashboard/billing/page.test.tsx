import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';

/*
 * Covers app/dashboard/billing/page.tsx's own wiring — authGateStates() and
 * useChannelBootstrap() — as distinct from BillingActionsPanel, which is
 * tested in isolation in billing-lifecycle.test.tsx /
 * billing-refresh-soon.test.tsx. This file never renders that panel's own
 * buttons; it only proves the page's gate/loading/ready states and its
 * role-based decision to show the panel at all.
 */

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1',
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

const getCurrentUser = controllable<Parameters<typeof api.getCurrentUser>, Awaited<ReturnType<typeof api.getCurrentUser>>>(async () => baseUser);
const getChannel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(async () => baseChannelDetails('owner'));
const getBilling = controllable<Parameters<typeof api.getBilling>, Awaited<ReturnType<typeof api.getBilling>>>(async () => baseBillingView);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: getCurrentUser.fn,
  getChannel: getChannel.fn,
  getBilling: getBilling.fn,
});

async function renderFreshPage(waitForShell = true) {
  const { default: BillingPage } = await import(`./page?t=${Math.random()}`);
  const rendered = render(<BillingPage />);
  if (waitForShell) await waitFor(() => screen.getByText('@testhandle'));
  return rendered;
}

test('while getCurrentUser (AppShell) and the page bootstrap are still pending, the page shows Loading… and never renders the plan heading', async () => {
  // A pending-but-eventually-resolved promise (not a truly never-resolving
  // one) — leaving a dangling unsettled promise at process exit stalls the
  // whole test file's teardown ("Promise resolution is still pending but
  // the event loop has already resolved"), confirmed by an isolated repro.
  let resolveCurrentUser: (value: api.CurrentUser) => void = () => {};
  const pendingCurrentUser = new Promise<api.CurrentUser>((resolve) => { resolveCurrentUser = resolve; });
  // BillingPage and AppShell both load the current user. Sharing the same
  // promise prevents the fixture from resolving one bootstrap while leaving
  // the other pending through test teardown.
  getCurrentUser.set(async () => pendingCurrentUser);
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => baseBillingView);
  await renderFreshPage(false);

  // Both AppShell's own sidebar identity fetch and authGateStates' ready
  // gate render "Loading…" while getCurrentUser is unresolved.
  await waitFor(() => assert.equal(screen.getAllByText('Loading…').length, 2));
  assert.equal(screen.queryByRole('heading', { level: 2 }), null);
  assert.equal(screen.queryByText('Only the channel owner or an admin can change the plan.'), null);
  resolveCurrentUser(baseUser);
  await waitFor(() => screen.getByText('@testhandle'));
});

test('when useChannelBootstrap\'s getCurrentUser call fails, the page renders the auth-gate error state, not a crash or an empty billing panel', async () => {
  getCurrentUser.set(async () => { throw new Error('Authentication required'); });
  await renderFreshPage(false);

  await waitFor(() => screen.getByRole('alert'));
  await waitFor(() => screen.getByText('Not signed in'));
  assert.equal(screen.getByRole('alert').textContent, 'Authentication required');
  assert.ok(screen.getByRole('link', { name: /Return to sign in/ }));
  // authGateStates' error branch renders before ready — no plan data at all.
  assert.equal(screen.queryByText('Only the channel owner or an admin can change the plan.'), null);
});

// NOTE: a signed-in user with no channels hits `window.location.assign(
// '/onboarding')` inside useChannelBootstrap's callback (page.tsx:20). This
// is deliberately NOT exercised here: triggering it under this jsdom setup
// logs "Not implemented: navigation to another Document" and reliably
// hangs the whole test file until the outer process timeout (confirmed by
// an isolated repro) — a jsdom/environment limitation, not something an
// assertion rewrite fixes. Per the harness README's own
// `window.location.assign` gotcha, this path needs an injectable
// navigation seam in the component to test safely; that's a source change,
// out of scope for this test-only task.

test('once getChannel + getBilling resolve, the page renders the plan heading and price sourced from useChannelBootstrap\'s own fetch, not AppShell\'s', async () => {
  getCurrentUser.set(async () => baseUser);
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'pro', monthlyPricePaise: 19900 }));
  await renderFreshPage();

  await waitFor(() => screen.getByText(/Pro · ₹199\/month/));
});

test('an admin role sees "Only the channel owner or an admin can change the plan" is false — the panel renders; a non-owner/admin role sees the restriction message and no panel', async () => {
  getCurrentUser.set(async () => baseUser);
  getChannel.set(async () => baseChannelDetails('viewer'));
  getBilling.set(async () => baseBillingView);
  await renderFreshPage();

  await waitFor(() => screen.getByText('Only the channel owner or an admin can change the plan.'));
  assert.equal(screen.queryByRole('button', { name: 'Subscribe' }), null);
});

test('an owner role does not see the role-restriction message — the billing actions panel renders instead', async () => {
  getCurrentUser.set(async () => baseUser);
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'free' }));
  await renderFreshPage();

  await waitFor(() => screen.getAllByRole('button', { name: 'Subscribe' }));
  assert.equal(screen.queryByText('Only the channel owner or an admin can change the plan.'), null);
});
