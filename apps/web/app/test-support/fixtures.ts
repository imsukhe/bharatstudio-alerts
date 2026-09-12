/*
 * Minimal, fully-typed synthetic fixtures shared by page component tests —
 * every field the real response types require, filled with made-up
 * (never real) data, so a test's `mockApi({ getBilling: async () => ... })`
 * doesn't have to restate every unrelated field `BillingView`/
 * `ChannelDetails` happen to require.
 */
import type { BillingView, ChannelDetails, ChannelRole } from '../lib/api';

export const baseBillingView: BillingView = {
  schemaVersion: 'v1',
  channelId: 'c1',
  tier: 'free',
  monthlyPricePaise: 0,
  annualMonthsCharged: 0,
  annualServiceMonths: 0,
  renewalState: 'not_applicable',
  nextRenewalAt: null,
  billingInterval: 'monthly',
  autoRenew: false,
  currentPeriodEndsAt: null,
  priceProtectedUntil: null,
  priceSource: 'current',
};

export function baseChannelDetails(role: ChannelRole = 'viewer'): ChannelDetails {
  return {
    schemaVersion: 'v1',
    channelId: 'c1',
    handle: 'testhandle',
    displayName: 'Test Channel',
    acceptingTips: true,
    publicConfigVersion: 1,
    featuredConsent: false,
    role,
  };
}
