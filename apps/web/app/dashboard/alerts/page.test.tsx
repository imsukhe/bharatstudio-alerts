import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';
import { baseBillingView } from '../../test-support/fixtures';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'viewer' as const, payoutOnboardingDone: true }],
};

const baseChannel = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  handle: 'testhandle',
  displayName: 'Test Channel',
  acceptingTips: true,
  publicConfigVersion: 1,
  featuredConsent: false,
  role: 'viewer' as const,
};

const baseConfig = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  version: 1,
  values: {},
  effectiveAt: '2026-01-01T00:00:00.000Z',
};

const currentUser = controllable<Parameters<typeof api.getCurrentUser>, Awaited<ReturnType<typeof api.getCurrentUser>>>(async () => baseUser);
const channel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(async () => baseChannel);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: currentUser.fn,
  getChannel: channel.fn,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: 'q1', channelId: 'c1', name: 'Main alerts', paused: false, active: true }] }),
  getChannelConfig: async () => baseConfig,
  getBindings: async () => ({ schemaVersion: 'v1', bindings: [] }),
  sendTestAlert: async () => ({ schemaVersion: 'v1', eventId: 'evt1', traceId: 'trace1', status: 'accepted' as const }),
});

async function renderFreshAlertsPage(waitForShell = true) {
  const { default: AlertsPage } = await import(`./page?t=${Math.random()}`);
  render(<AlertsPage />);
  if (waitForShell) await waitFor(() => screen.getByText('@testhandle'));
}

test('shows Loading… while the channel bootstrap is in flight', async () => {
  let resolveCurrentUser: (value: typeof baseUser) => void = () => {};
  const pendingCurrentUser = new Promise<typeof baseUser>((resolve) => { resolveCurrentUser = resolve; });
  let resolveChannel: (value: typeof baseChannel) => void = () => {};
  const pendingChannel = new Promise<typeof baseChannel>((resolve) => { resolveChannel = resolve; });
  currentUser.set(async () => pendingCurrentUser);
  // Both AlertsPage and AppShell read this channel. They must share one
  // pending promise so resolving the test fixture settles both effects.
  channel.set(async () => pendingChannel);
  await renderFreshAlertsPage(false);
  assert.equal(screen.getByRole('status').textContent, 'Loading…');
  await act(async () => {
    resolveCurrentUser(baseUser);
    resolveChannel(baseChannel);
  });
  await waitFor(() => screen.getByText('Main alerts'));
  await waitFor(() => screen.getByText('@testhandle'));
});

test('shows the sign-in error state when the bootstrap fetch fails', async () => {
  currentUser.set(async () => { throw new Error('Account data is unavailable'); });
  await renderFreshAlertsPage(false);
  await waitFor(() => screen.getByRole('alert'));
  await waitFor(() => screen.getByText('Not signed in'));
  assert.equal(screen.getByRole('alert').textContent, 'Account data is unavailable');
});

test('a viewer-role channel member can see the queue but not pause it or send a test alert', async () => {
  currentUser.set(async () => baseUser); // role: 'viewer'
  channel.set(async () => baseChannel);
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByText('Main alerts'));
  assert.equal(screen.queryByRole('button', { name: /Pause|Resume/ }), null);
  assert.ok(screen.getByText(/Your channel role can view the queue state but cannot send test alerts/));
});

test('an operator can pause the queue and send a test alert', async () => {
  currentUser.set(async () => ({ ...baseUser, channels: [{ ...baseUser.channels[0], role: 'operator' as const }] }));
  channel.set(async () => ({ ...baseChannel, role: 'operator' as const }));
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByText('Main alerts'));
  assert.ok(screen.getByRole('button', { name: 'Pause' }));
  assert.ok(screen.getByRole('button', { name: 'Send test alert' }));
});

test('sending a test alert renders the success StatusMessage, not an error one', async () => {
  currentUser.set(async () => ({ ...baseUser, channels: [{ ...baseUser.channels[0], role: 'operator' as const }] }));
  channel.set(async () => ({ ...baseChannel, role: 'operator' as const }));
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByRole('button', { name: 'Send test alert' }));

  fireEvent.click(screen.getByRole('button', { name: 'Send test alert' }));

  await waitFor(() => screen.getByText('Test alert accepted and added to the durable alert path.'));
  const status = screen.getByText('Test alert accepted and added to the durable alert path.');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.className, 'inline-message');
});
