import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';
import { baseBillingView } from '../../test-support/fixtures';

// Covers AlertsPage's PATCH-config round trip (config.version -> the
// if-match-version header, per app/lib/api.ts's updateChannelConfig) —
// specifically the two ways the server can refuse a save that the client
// itself never blocks: an optimistic-locking version conflict, and an
// entitlement-driven field limit. Neither is a crash; both are real,
// user-visible states the page must recover from cleanly.

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'operator' as const, payoutOnboardingDone: true }],
};

const baseChannel = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  handle: 'testhandle',
  displayName: 'Test Channel',
  acceptingTips: true,
  publicConfigVersion: 1,
  featuredConsent: false,
  role: 'operator' as const,
};

const baseConfig = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  version: 5,
  values: { minimumTipPaise: 1000 },
  effectiveAt: '2026-01-01T00:00:00.000Z',
};

const updateChannelConfig = controllable<Parameters<typeof api.updateChannelConfig>, Awaited<ReturnType<typeof api.updateChannelConfig>>>(
  async () => baseConfig,
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannel,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [] }),
  getChannelConfig: async () => baseConfig,
  getBindings: async () => ({ schemaVersion: 'v1', bindings: [] }),
  updateChannelConfig: updateChannelConfig.fn,
});

async function renderFreshAlertsPage() {
  const { default: AlertsPage } = await import(`./page?t=${Math.random()}`);
  render(<AlertsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('a version conflict on save surfaces the server message and leaves the stale version/draft in place for the user to reconcile, not a crash or a silent overwrite', async () => {
  updateChannelConfig.set(async () => { throw new Error('This configuration changed elsewhere. Reload and try again.'); });
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByText('Alert configuration · v5'));

  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'This configuration changed elsewhere. Reload and try again.');
  // The version shown is still the pre-conflict one — the page did not
  // fabricate a new version locally after the rejected PATCH.
  assert.ok(screen.getByText('Alert configuration · v5'));
  // Saving flag must have been released so the user can retry.
  assert.ok(screen.getByRole('button', { name: 'Save configuration' }));
});

test('an entitlement-denied field value is refused by the server, not silently clamped by the client', async () => {
  updateChannelConfig.set(async () => { throw new Error('Your plan allows at most 3 amount brackets. Upgrade to add more.'); });
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByText('Alert configuration · v5'));

  // Push the char-limit field to a value a lower tier would not be
  // entitled to, then submit — the component itself applies no tier
  // awareness (see ChannelConfigEditor.tsx), so this must round-trip to
  // the server and come back refused, with the attempted value still
  // visible in the draft (not reset, not clamped down for the user).
  const charLimitInput = screen.getByLabelText(/Message limit/);
  fireEvent.change(charLimitInput, { target: { value: '480' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Your plan allows at most 3 amount brackets. Upgrade to add more.');
  assert.equal((screen.getByLabelText(/Message limit/) as HTMLInputElement).value, '480');
});

test('a successful save adopts the server-returned version, so the next PATCH uses the fresh optimistic-lock token', async () => {
  updateChannelConfig.set(async () => ({ ...baseConfig, version: 6, values: { ...baseConfig.values, minimumTipPaise: 2500 } }));
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByText('Alert configuration · v5'));

  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

  await waitFor(() => screen.getByText('Alert configuration · v6'));
  assert.ok(screen.getByText('Alert configuration saved.'));
});
