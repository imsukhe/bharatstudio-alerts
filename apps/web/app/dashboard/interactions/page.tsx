'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, getQueues, type ChannelDetails } from '../../lib/api';
import { InteractionsPanel } from './InteractionsPanel';

export default function InteractionsPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [queueId, setQueueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    const [channelDetails, queues] = await Promise.all([getChannel(first.channelId), getQueues(first.channelId)]);
    setChannel(channelDetails);
    setQueueId(queues.queues[0]?.queueId ?? null);
  }, setError);

  const canManage = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Interactions & widgets', error, ready: true });
  if (!channel) return authGateStates({ title: 'Interactions & widgets', error: null, ready: false });

  return (
    <AppShell title="Interactions & widgets">
      <section className="panel" aria-labelledby="interactions-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Interactions & widgets</p>
            <h2 id="interactions-title">Turn a tip into an interaction, and put support state on screen</h2>
          </div>
        </div>
        {!queueId && <p className="helper-text">Create an alert queue first — every interaction routes to one.</p>}
        {queueId && <InteractionsPanel channelId={channel.channelId} canManage={canManage} queueId={queueId} />}
      </section>
    </AppShell>
  );
}
