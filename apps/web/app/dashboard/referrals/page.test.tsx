import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};
function channelWithRole(role: api.ChannelRole): api.ChannelDetails {
  return { schemaVersion: 'v1', channelId: 'c1', handle: 'testhandle', displayName: 'Test Channel', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role };
}
const baseOverview: api.ReferralOverview = {
  schemaVersion: 'v1', pendingCount: 1, paidPendingHoldCount: 0, creditedCount: 2, flaggedOrRevokedCount: 0, bankedCreditDays: 0, lifetimeCreditedDays: 14,
};
const baseHistory: api.ReferralHistory = { schemaVersion: 'v1', items: [] };

const channel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(
  async () => channelWithRole('owner'),
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: channel.fn,
  getBilling: async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'free', monthlyPricePaise: 0, annualMonthsCharged: 0, annualServiceMonths: 0, renewalState: 'not_applicable', nextRenewalAt: null, billingInterval: 'monthly', autoRenew: false, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current' }),
  getReferralOverview: async () => baseOverview,
  getReferralHistory: async () => baseHistory,
});

test('an owner sees the referral panel with real overview stats', async () => {
  channel.set(async () => channelWithRole('owner'));
  const { default: ReferralsPage } = await import(`./page?t=${Math.random()}`);
  render(<ReferralsPage />);

  await waitFor(() => screen.getByText('Invite creators, earn service time'));
  assert.equal(screen.getByLabelText('Your referral link').getAttribute('value'), 'http://localhost:3100/login?ref=testhandle');
  await waitFor(() => screen.getByText('14')); // lifetimeCreditedDays stat, loaded async by ReferralPanel
});

test('a moderator (not owner/admin) is told only the owner or admin can view referrals, and never sees the panel', async () => {
  channel.set(async () => channelWithRole('moderator'));
  const { default: ReferralsPage } = await import(`./page?t=${Math.random()}`);
  render(<ReferralsPage />);

  await waitFor(() => screen.getByText('Only the channel owner or an admin can view referrals.'));
  assert.equal(screen.queryByLabelText('Your referral link'), null);
});

test('an admin (not just owner) also sees the referral panel — role check is inclusive of admin', async () => {
  channel.set(async () => channelWithRole('admin'));
  const { default: ReferralsPage } = await import(`./page?t=${Math.random()}`);
  render(<ReferralsPage />);

  await waitFor(() => screen.getByLabelText('Your referral link'));
});
