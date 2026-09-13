'use client';

import { useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelDetails } from '../../lib/api';
import { StickerPanel } from './StickerPanel';
import { CreatorPackPanel } from './CreatorPackPanel';

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
      <section className="panel" aria-labelledby="creator-pack-title">
        <div className="panel-heading">
          <div>
            <p className="muted-label">Creator pack</p>
            <h2 id="creator-pack-title">Your own approved stickers</h2>
          </div>
        </div>
        <p className="helper-text">These are your own uploaded stickers, bounded by your tier and validated the same way the platform catalogue is. Viewers can never upload their own.</p>
        <CreatorPackPanel channelId={channel.channelId} canManage={canManage} />
      </section>
    </AppShell>
  );
}
