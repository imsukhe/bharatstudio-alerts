'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelDetails } from '../../lib/api';
import { StickerPanel } from './StickerPanel';

export default function StickersPage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useChannelBootstrap(async (user) => {
    const first = user.channels[0];
    if (!first) { window.location.assign('/onboarding'); return; }
    setChannel(await getChannel(first.channelId));
  }, setError);

  const canManage = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  if (error) return authGateStates({ title: 'Stickers', error, ready: true });
  if (!channel) return authGateStates({ title: 'Stickers', error: null, ready: false });

  return (
    <AppShell title="Stickers">
      <section className="panel" aria-labelledby="stickers-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Stickers</p>
            <h2 id="stickers-title">Choose what viewers can trigger</h2>
          </div>
        </div>
        <p className="helper-text">Every sticker here is BharatStudio-approved and available at your tier. Turn any of them off to remove it from your stream immediately — viewers can never upload their own.</p>
        <StickerPanel channelId={channel.channelId} canManage={canManage} />
      </section>
    </AppShell>
  );
}
