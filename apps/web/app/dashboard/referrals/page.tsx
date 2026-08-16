'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { getChannel, getCurrentUser, type ChannelDetails } from '../../lib/api';
import { ReferralPanel } from '../ReferralPanel';

export default function ReferralsPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then(async (user) => {
      const first = user.channels[0];
      if (!first) { window.location.assign('/onboarding'); return; }
      setChannel(await getChannel(first.channelId));
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  const canManageBilling = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return <AppShell title="Referrals"><p className="error-text" role="alert">{error}</p><Link className="text-link" href="/login">Return to sign in →</Link></AppShell>;
  if (!channel) return <AppShell title="Referrals"><p className="helper-text" role="status">Loading…</p></AppShell>;

  return (
    <AppShell title="Referrals">
      {!canManageBilling ? (
        <section className="panel"><p className="helper-text">Only the channel owner or an admin can view referrals.</p></section>
      ) : (
        <section className="panel" aria-labelledby="referral-title">
          <div className="panel-heading"><div><p className="muted-label">Referrals</p><h2 id="referral-title">Invite creators, earn service time</h2></div></div>
          <ReferralPanel channelId={channel.channelId} handle={channel.handle} />
        </section>
      )}
    </AppShell>
  );
}
