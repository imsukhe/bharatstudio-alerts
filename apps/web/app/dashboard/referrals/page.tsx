'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
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

  const canViewReferrals = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Referrals', error, ready: true });
  if (!channel) return authGateStates({ title: 'Referrals', error: null, ready: false });

  return (
    <AppShell title="Referrals">
      {!canViewReferrals ? (
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
