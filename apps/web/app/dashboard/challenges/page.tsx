'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelDetails } from '../../lib/api';
import { ChallengesPanel } from './ChallengesPanel';

export default function ChallengesPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    setChannel(await getChannel(first.channelId));
  }, setError);

  const canManage = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Challenges', error, ready: true });
  if (!channel) return authGateStates({ title: 'Challenges', error: null, ready: false });

  return (
    <AppShell title="Challenges">
      <section className="panel" aria-labelledby="challenges-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Challenges</p>
            <h2 id="challenges-title">Set a target with a stake or a bounty</h2>
          </div>
        </div>
        <p className="helper-text">Progress is calculated from confirmed payments only — never a counter you can set directly, and a refund you issue yourself in your payment provider's dashboard reduces it automatically.</p>
        <ChallengesPanel channelId={channel.channelId} canManage={canManage} />
      </section>
    </AppShell>
  );
}
