'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { getBilling, getChannel, getCurrentUser, type BillingView, type ChannelDetails } from '../../lib/api';
import { BrandingPanel } from '../BrandingPanel';

export default function CustomisePage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then(async (user) => {
      const first = user.channels[0];
      if (!first) { window.location.assign('/onboarding'); return; }
      const [nextChannel, nextBilling] = await Promise.all([getChannel(first.channelId), getBilling(first.channelId)]);
      setChannel(nextChannel); setBilling(nextBilling);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  const canManageBilling = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return <AppShell title="Customise"><p className="error-text" role="alert">{error}</p><Link className="text-link" href="/login">Return to sign in →</Link></AppShell>;
  if (!channel || !billing) return <AppShell title="Customise"><p className="helper-text" role="status">Loading…</p></AppShell>;

  return (
    <AppShell title="Customise">
      <p className="lede" style={{ margin: '0 0 24px' }}>Custom Lottie alert animations, per display style.</p>
      {!canManageBilling ? (
        <section className="panel"><p className="helper-text">Only the channel owner or an admin can manage branding.</p></section>
      ) : billing.tier !== 'studio' ? (
        <section className="panel"><p className="helper-text">Custom branding requires the Studio plan. <a className="text-link" href="/dashboard/billing">Manage billing →</a></p></section>
      ) : (
        <section className="panel" aria-labelledby="branding-title">
          <div className="panel-heading"><div><p className="muted-label">Branding</p><h2 id="branding-title">Custom alert animations</h2></div></div>
          <BrandingPanel channelId={channel.channelId} />
        </section>
      )}
    </AppShell>
  );
}
