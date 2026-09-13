'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getBilling, getChannel, type BillingView, type ChannelDetails } from '../../lib/api';
import { AssistPanel } from './AssistPanel';

export default function AssistPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    const [loadedChannel, loadedBilling] = await Promise.all([getChannel(first.channelId), getBilling(first.channelId)]);
    setChannel(loadedChannel);
    setBilling(loadedBilling);
  }, setError);

  if (error) return authGateStates({ title: 'AI assist', error, ready: true });
  if (!channel || !billing) return authGateStates({ title: 'AI assist', error: null, ready: false });

  const canRequest = billing.tier !== 'free';

  return (
    <AppShell title="AI assist">
      <section className="panel" aria-labelledby="assist-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">AI assist</p>
            <h2 id="assist-title">Suggestions you review, never actions taken for you</h2>
          </div>
        </div>
        <p className="helper-text">Every suggestion here is a proposal. Accepting one records your decision — it never posts to your stream, captures a payment, or changes anything live by itself.</p>
        <AssistPanel channelId={channel.channelId} role={channel.role} tier={billing.tier} canRequest={canRequest} />
      </section>
    </AppShell>
  );
}
