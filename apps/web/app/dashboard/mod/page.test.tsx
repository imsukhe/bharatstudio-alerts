import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';
import { baseBillingView } from '../../test-support/fixtures';

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

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: currentUser.fn,
  getChannel: async () => baseChannel,
  getHistory: async () => ({ schemaVersion: 'v1', items: [], nextCursor: null }),
});

async function renderFreshModPage() {
  const { default: ModConsolePage } = await import(`./page?t=${Math.random()}`);
  render(<ModConsolePage />);
}

test('shows Loading… before the channel bootstrap resolves, then the mod console', async () => {
  let resolveUser: (value: typeof baseUser) => void = () => {};
  currentUser.set(() => new Promise((resolve) => { resolveUser = resolve; }));
  await renderFreshModPage();
  assert.equal(screen.getByRole('status').textContent, 'Loading…');
  resolveUser(baseUser);
  await waitFor(() => screen.getByRole('heading', { name: 'Mod console' }));
});

test('shows the sign-in error state when the bootstrap fetch fails', async () => {
  currentUser.set(async () => { throw new Error('Account data is unavailable'); });
  await renderFreshModPage();
  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Account data is unavailable');
});
