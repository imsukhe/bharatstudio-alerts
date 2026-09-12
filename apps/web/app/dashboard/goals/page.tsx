'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelDetails } from '../../lib/api';
import { GoalsPanel } from './GoalsPanel';

export default function GoalsPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    setChannel(await getChannel(first.channelId));
  }, setError);

  const canManage = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Support goals', error, ready: true });
  if (!channel) return authGateStates({ title: 'Support goals', error: null, ready: false });

  return (
    <AppShell title="Support goals">
      <section className="panel" aria-labelledby="goals-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Support goals</p>
            <h2 id="goals-title">Set a target for viewers to fill</h2>
          </div>
        </div>
        <p className="helper-text">Progress is calculated from confirmed payments only — never a counter you can set directly, and a refunded tip reduces progress automatically.</p>
        <GoalsPanel channelId={channel.channelId} canManage={canManage} />
      </section>
    </AppShell>
  );
}
