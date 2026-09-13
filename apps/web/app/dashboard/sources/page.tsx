'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelDetails } from '../../lib/api';
import { SourcesPanel } from './SourcesPanel';

export default function ContributionSourcesPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    setChannel(await getChannel(first.channelId));
  }, setError);

  const canManage = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Contribution sources', error, ready: true });
  if (!channel) return authGateStates({ title: 'Contribution sources', error: null, ready: false });

  return (
    <AppShell title="Contribution sources">
      <section className="panel" aria-labelledby="sources-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Contribution sources</p>
            <h2 id="sources-title">Choose what counts toward each target</h2>
          </div>
        </div>
        <p className="helper-text">Include or exclude BharatStudio tips and YouTube Super Chats per goal, challenge, or interaction. There is no percentage or split option — a source either counts in full or not at all.</p>
        <SourcesPanel channelId={channel.channelId} canManage={canManage} />
      </section>
    </AppShell>
  );
}
