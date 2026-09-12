import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner' as const, payoutOnboardingDone: true }],
};

const baseChannel = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  handle: 'testhandle',
  displayName: 'Test Channel',
  acceptingTips: true,
  publicConfigVersion: 1,
  featuredConsent: false,
  role: 'owner' as const,
};

const baseBilling = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  tier: 'free' as const,
  monthlyPricePaise: 0,
  annualMonthsCharged: 0,
  annualServiceMonths: 0,
  renewalState: 'not_applicable' as const,
  nextRenewalAt: null,
  billingInterval: 'monthly' as const,
  autoRenew: false,
  currentPeriodEndsAt: null,
  priceProtectedUntil: null,
  priceSource: 'current' as const,
};

const billing = controllable<Parameters<typeof api.getBilling>, Awaited<ReturnType<typeof api.getBilling>>>(async () => baseBilling);

// mockApi(...) runs ONCE for this whole file — see mock-api.ts/controllable.ts.
mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannel,
  getBilling: billing.fn,
  getLottieAssets: async () => ({ schemaVersion: 'v1', items: [] }),
});

async function renderFreshCustomisePage() {
  const { default: CustomisePage } = await import(`./page?t=${Math.random()}`);
  render(<CustomisePage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('a Free-tier owner is told branding requires Studio, and never sees the branding panel', async () => {
  billing.set(async () => ({ ...baseBilling, tier: 'free' }));
  await renderFreshCustomisePage();
  await waitFor(() => screen.getByText(/Custom branding requires the Studio plan/));
  // BrandingPanel renders a "Custom alert animations" heading when shown —
  // a Free-tier owner must never receive it, not even hidden in the DOM.
  assert.equal(screen.queryByText('Custom alert animations'), null);
  assert.ok(screen.getByRole('link', { name: /Manage billing/ }));
});

test('a Studio-tier owner sees the branding panel instead of the upsell message', async () => {
  billing.set(async () => ({ ...baseBilling, tier: 'studio' }));
  await renderFreshCustomisePage();
  await waitFor(() => screen.getByText('Custom alert animations'));
  assert.equal(screen.queryByText(/Custom branding requires the Studio plan/), null);
});
