'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getBilling, getChannel, type BillingView, type ChannelDetails } from '../../lib/api';
import { BillingActionsPanel } from '../BillingActionsPanel';

function formatPlanPrice(monthlyPricePaise: number): string {
  return monthlyPricePaise === 0 ? 'Free' : `₹${Math.round(monthlyPricePaise / 100).toLocaleString('en-IN')}/month`;
}

export default function BillingPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    const [nextChannel, nextBilling] = await Promise.all([getChannel(first.channelId), getBilling(first.channelId)]);
    setChannel(nextChannel); setBilling(nextBilling);
  }, setError);

  const canManageBilling = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Billing', error, ready: true });
  if (!channel || !billing) return authGateStates({ title: 'Billing', error: null, ready: false });

  return (
    <AppShell title="Billing">
      <section className="panel" aria-labelledby="billing-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Plan</p>
            <h2 id="billing-title">{billing.tier[0].toUpperCase() + billing.tier.slice(1)} · {formatPlanPrice(billing.monthlyPricePaise)}</h2>
          </div>
          <span className="helper-text">{billing.renewalState === 'not_applicable' ? 'No recurring subscription' : billing.renewalState.replaceAll('_', ' ')}</span>
        </div>
        <p className="helper-text">
          {billing.billingInterval === 'annual' ? `${billing.annualMonthsCharged} months charged for ${billing.annualServiceMonths} months of service` : 'Monthly billing'} · {billing.autoRenew ? 'Auto-renew on' : 'Auto-renew off'}
        </p>
        {billing.priceSource === 'grandfathered' && billing.priceProtectedUntil && (
          <p className="helper-text">Protected price through {new Date(billing.priceProtectedUntil).toLocaleDateString('en-IN')} while the subscription remains eligible.</p>
        )}
        {billing.renewalState === 'past_due' && billing.currentPeriodEndsAt && (
          <p className="helper-text">
            Payment attention required. Access follows the approved grace and dunning policy through {new Date(billing.currentPeriodEndsAt).toLocaleDateString('en-IN')}.
            {' '}Retry the payment below, or update your payment method if your card/UPI account changed or expired.
          </p>
        )}
        {canManageBilling ? (
          <BillingActionsPanel channelId={channel.channelId} billing={billing} onUpdated={setBilling} />
        ) : (
          <p className="helper-text">Only the channel owner or an admin can change the plan.</p>
        )}
      </section>
    </AppShell>
  );
}
