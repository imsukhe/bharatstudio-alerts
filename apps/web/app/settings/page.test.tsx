import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';
import { baseBillingView } from '../test-support/fixtures';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'moderator' as const, payoutOnboardingDone: true }],
};

const baseChannel = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  handle: 'testhandle',
  displayName: 'Test Channel',
  acceptingTips: true,
  publicConfigVersion: 1,
  featuredConsent: false,
  role: 'moderator' as const,
};

const currentUser = controllable<Parameters<typeof api.getCurrentUser>, Awaited<ReturnType<typeof api.getCurrentUser>>>(async () => baseUser);
const channel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(async () => baseChannel);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: currentUser.fn,
  getChannel: channel.fn,
  getPaymentAccounts: async () => ({ schemaVersion: 'v1', accounts: [] }),
  getPrivacyRequests: async () => ({ schemaVersion: 'v1', requests: [] }),
});

async function renderFreshSettingsPage() {
  const { default: SettingsPage } = await import(`./page?t=${Math.random()}`);
  render(<SettingsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('a moderator (not owner/admin) cannot edit the display name or handle', async () => {
  currentUser.set(async () => baseUser); // role: 'moderator'
  channel.set(async () => baseChannel);
  await renderFreshSettingsPage();
  await waitFor(() => screen.getByDisplayValue('Test Channel'));

  const displayNameInput = screen.getByDisplayValue('Test Channel') as HTMLInputElement;
  assert.equal(displayNameInput.disabled, true);
  assert.equal(screen.queryByRole('button', { name: 'Save display name' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Save handle' }), null);
  assert.ok(screen.getByText('Only the channel owner or an admin can change the handle.'));
});

test('an owner can edit the display name and see the save controls', async () => {
  currentUser.set(async () => ({ ...baseUser, channels: [{ ...baseUser.channels[0], role: 'owner' as const }] }));
  channel.set(async () => ({ ...baseChannel, role: 'owner' as const }));
  await renderFreshSettingsPage();
  await waitFor(() => screen.getByDisplayValue('Test Channel'));

  const displayNameInput = screen.getByDisplayValue('Test Channel') as HTMLInputElement;
  assert.equal(displayNameInput.disabled, false);
  assert.ok(screen.getByRole('button', { name: 'Save display name' }));
  assert.equal(screen.queryByText('Only the channel owner or an admin can change the handle.'), null);
});
